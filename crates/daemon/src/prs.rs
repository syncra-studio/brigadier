//! The PR watch [D1009, D1017, D1047, D1192]: every published, unarchived session's PRs read on
//! the host's own CLI on a schedule, as VS Code's PR extension polls: every 30 s while
//! checks run, 2 min with a PR open, 5 min otherwise or with no window open (proposed, D1047).
//! Each read keeps `prs.json` in the session's folder, whose change the index publishes on the
//! session's row. It never wakes the agent [D1027].

use super::Shared;
use brigadier_core::{host, ids, session_dir};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

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
        // When each session is read next, and those being read now: one slow host never holds up
        // the others, and no session is read twice at once.
        let next: Arc<Mutex<HashMap<String, Instant>>> = Arc::default();
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
                let due = !next
                    .lock()
                    .unwrap()
                    .get(&id)
                    .is_some_and(|at| *at > Instant::now());
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
                    next.lock().unwrap().insert(id.clone(), at);
                    busy.lock().unwrap().remove(&id);
                });
            }
            thread::sleep(TICK);
        }
    });
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
