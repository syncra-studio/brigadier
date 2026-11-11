//! The PR watch [D1009, D1017, D1047, D1192]: every published, unarchived session's PRs read on
//! the host's own CLI on a schedule, as VS Code's PR extension polls: every 30 s while
//! checks run, 2 min with a PR open, 5 min otherwise or with no window open (proposed, D1047).
//! Each read keeps `prs.json` in the session's folder, whose change the index publishes on the
//! session's row. It never wakes the agent [D1027].

use super::Shared;
use brigadier_core::{host, ids, session_dir};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
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

pub(super) fn turned(ids: &[&str]) {
    DUE.lock()
        .unwrap()
        .extend(ids.iter().map(|id| id.to_string()));
}

pub(super) fn watch(data: PathBuf, state: Shared) {
    thread::spawn(move || {
        // When each session is read next, with its `prs.json` as that read left it, and those
        // being read now: one slow host never holds up the others, no session is read twice at
        // once, and PRs another read kept (Create PR's, on focus) set its pace at once.
        let next: Arc<Mutex<HashMap<String, Next>>> = Arc::default();
        let busy: Arc<Mutex<HashSet<String>>> = Arc::default();
        loop {
            let ids = ids(&data);
            next.lock().unwrap().retain(|id, _| ids.contains(id));
            // One being read now may have started before the turn: it stays due for after.
            DUE.lock().unwrap().retain(|id| {
                next.lock().unwrap().remove(id);
                busy.lock().unwrap().contains(id)
            });
            for id in ids {
                let now_at = kept_at(&data, &id);
                let due = !next
                    .lock()
                    .unwrap()
                    .get(&id)
                    .is_some_and(|(at, left)| *at > Instant::now() && *left == now_at);
                let mut reading = busy.lock().unwrap();
                if !due || reading.len() >= AT_ONCE || !reading.insert(id.clone()) {
                    continue;
                }
                drop(reading);
                let (data, state, next, busy) =
                    (data.clone(), state.clone(), next.clone(), busy.clone());
                thread::spawn(move || {
                    let kept = match session_dir(&data, &id).join("archived").exists() {
                        true => None,
                        false => host::pr(&data, &id).ok().and_then(|pr| pr.watch()),
                    };
                    // A window is open while the app is subscribed.
                    let window = !state.lock().unwrap().subs.is_empty();
                    let at = Instant::now() + every(kept.as_ref(), window);
                    // Under DUE's lock, as the scheduler reads it: a turn noted meanwhile is never lost.
                    let _due = DUE.lock().unwrap();
                    next.lock()
                        .unwrap()
                        .insert(id.clone(), (at, kept_at(&data, &id)));
                    busy.lock().unwrap().remove(&id);
                });
            }
            thread::sleep(TICK);
        }
    });
}

/// When a session is read next, and its `prs.json` as that read left it.
type Next = (Instant, Option<SystemTime>);

fn kept_at(data: &Path, id: &str) -> Option<SystemTime> {
    std::fs::metadata(session_dir(data, id).join("prs.json"))
        .and_then(|m| m.modified())
        .ok()
}

fn every(kept: Option<&Value>, window: bool) -> Duration {
    let prs = kept.and_then(|k| k["prs"].as_array()).into_iter().flatten();
    let open: Vec<&Value> = prs.filter(|p| p["state"] == "open").collect();
    match () {
        _ if !window || open.is_empty() => QUIET,
        _ if open
            .iter()
            .any(|p| p["running"].as_u64().is_some_and(|n| n > 0)) =>
        {
            RUNNING
        }
        _ => OPEN,
    }
}
