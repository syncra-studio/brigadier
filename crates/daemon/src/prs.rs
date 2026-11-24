//! The PR watch [D1009, D1017, D1047, D1192]: every published, unarchived session's PRs read on
//! the host's own CLI on a schedule, as VS Code's PR extension polls: every 30 s while
//! checks run, 2 min with a PR open or none yet, 5 min otherwise or with no window open (proposed, D1047).
//! Each read keeps `prs.json` in the session's folder, whose change the index publishes on the
//! session's row; a folder chat's, with each claimed repo's. It never wakes the agent [D1027]. A session made due (a turn, its card opened,
//! its branch pushed) is read at once, before the rest [D200].

use super::Shared;
use brigadier_core::{host, ids, session_dir};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

const TICK: Duration = Duration::from_secs(10);
const RUNNING: Duration = Duration::from_secs(30);
const OPEN: Duration = Duration::from_secs(2 * 60);
const QUIET: Duration = Duration::from_secs(5 * 60);
/// Proposed: how many sessions' hosts are read at once.
const AT_ONCE: usize = 4;

/// Sessions whose turn began or ended, read on the watch's next tick: a turn may commit or open a PR.
static DUE: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// Sessions whose card opened (or whose branch was pushed), read before any other.
static SHOWN: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// Set when a session became due or a read ended: the schedule runs again now, not at its tick.
static POKED: Mutex<bool> = Mutex::new(false);
static WAKE: Condvar = Condvar::new();

fn poke() {
    *POKED.lock().unwrap() = true;
    WAKE.notify_one();
}

/// These sessions' PRs are read now: a turn began or ended.
pub(super) fn turned(ids: &[&str]) {
    if ids.is_empty() {
        return;
    }
    DUE.lock()
        .unwrap()
        .extend(ids.iter().map(|id| id.to_string()));
    poke();
}

/// These sessions' PRs are read now, first: their card opened, the window took focus, or their
/// branch was pushed [D200].
pub(super) fn shown(ids: &[&str]) {
    SHOWN
        .lock()
        .unwrap()
        .extend(ids.iter().map(|id| id.to_string()));
    turned(ids);
    // A folder chat's card lists its own beside the claimed repo's picked on it [D494].
    let chats: Vec<&str> = (ids.iter())
        .filter_map(|id| Some(id.split_once('@')?.0))
        .filter(|id| !id.is_empty())
        .collect();
    turned(&chats);
}

pub(super) fn watch(data: PathBuf, state: Shared) {
    thread::spawn(move || {
        // When each session is read next, with its `prs.json` as that read left it, and those
        // being read now: one slow host never holds up the others, no session is read twice at
        // once, and PRs another read kept (Create PR's, on focus) set its pace at once.
        let next: Arc<Mutex<HashMap<String, Next>>> = Arc::default();
        let busy: Arc<Mutex<HashSet<String>>> = Arc::default();
        loop {
            // A folder chat's claimed repos are read each as its own, `<id>@<repo>` [D494].
            let mut ids: Vec<String> = (ids(&data).into_iter())
                .flat_map(|id| {
                    let claims = brigadier_core::folder::claims(&session_dir(&data, &id));
                    let repos = claims.into_iter().map(|(name, _)| format!("{id}@{name}"));
                    std::iter::once(id.clone()).chain(repos.collect::<Vec<_>>())
                })
                .collect();
            next.lock().unwrap().retain(|id, _| ids.contains(id));
            // One being read now may have started before the turn: it stays due for after.
            let mut due = DUE.lock().unwrap();
            // Those shown go first, then those made due: one just opened never waits behind the rest.
            let shown = SHOWN.lock().unwrap().clone();
            ids.sort_by_key(|id| (!shown.contains(id), !due.contains(id)));
            let first = due.clone();
            due.retain(|id| {
                next.lock().unwrap().remove(id);
                busy.lock().unwrap().contains(id)
            });
            drop(due);
            // Made due but every slot is taken: it stays first for when one frees.
            let mut waiting = Vec::new();
            for id in ids {
                let now_at = kept_at(&data, &id);
                let due = !next
                    .lock()
                    .unwrap()
                    .get(&id)
                    .is_some_and(|(at, left)| *at > Instant::now() && *left == now_at)
                    || host::moved_on(&data, &id);
                let mut reading = busy.lock().unwrap();
                if due && reading.len() >= AT_ONCE && first.contains(&id) {
                    waiting.push(id.clone());
                }
                if !due || reading.len() >= AT_ONCE || !reading.insert(id.clone()) {
                    continue;
                }
                drop(reading);
                SHOWN.lock().unwrap().retain(|shown| *shown != id);
                let (data, state, next, busy) =
                    (data.clone(), state.clone(), next.clone(), busy.clone());
                thread::spawn(move || {
                    // A window is open while the app is subscribed.
                    let window = !state.lock().unwrap().subs.is_empty();
                    let dir = session_dir(&data, &id);
                    let kept = match dir.join("archived").exists() {
                        true => None,
                        false => match host::pr(&data, &id) {
                            Ok(pr) => {
                                let kept = pr.watch();
                                // An open PR's tab is read at the same pace, so it opens on a fresh read [D207].
                                if kept.is_some() && window {
                                    for (other, n) in host::tabbed(&dir) {
                                        let _ = pr.view(other.as_deref(), n);
                                    }
                                }
                                kept
                            }
                            // A folder chat has no checkout of its own.
                            Err(_) => host::chat(&data, &id),
                        },
                    };
                    let at = Instant::now() + every(kept.as_ref(), window);
                    // Under DUE's lock, as the scheduler reads it: a turn noted meanwhile is never lost.
                    let _due = DUE.lock().unwrap();
                    next.lock()
                        .unwrap()
                        .insert(id.clone(), (at, kept_at(&data, &id)));
                    busy.lock().unwrap().remove(&id);
                    poke();
                });
            }
            DUE.lock().unwrap().extend(waiting);
            let poked = POKED.lock().unwrap();
            let (mut poked, _) = WAKE
                .wait_timeout_while(poked, TICK, |poked| !*poked)
                .unwrap();
            *poked = false;
        }
    });
}

/// When a session is read next, and its `prs.json` as that read left it.
type Next = (Instant, Option<SystemTime>);

fn kept_at(data: &Path, id: &str) -> Option<SystemTime> {
    // A claimed repo's are beside its claim; a session's own, read without the projects list.
    let dir = match id.contains('@') {
        true => host::dir(data, id),
        false => session_dir(data, id),
    };
    std::fs::metadata(dir.join("prs.json"))
        .and_then(|m| m.modified())
        .ok()
}

fn every(kept: Option<&Value>, window: bool) -> Duration {
    let prs: Vec<&Value> = (kept.and_then(|k| k["prs"].as_array()).into_iter().flatten()).collect();
    let open: Vec<&&Value> = prs.iter().filter(|p| p["state"] == "open").collect();
    match () {
        _ if !window => QUIET,
        // Published with no PR yet: one made outside the app (gh, the host's page) shows soon.
        _ if kept.is_some() && prs.is_empty() => OPEN,
        _ if open.is_empty() => QUIET,
        _ if open
            .iter()
            .any(|p| p["running"].as_u64().is_some_and(|n| n > 0)) =>
        {
            RUNNING
        }
        _ => OPEN,
    }
}
