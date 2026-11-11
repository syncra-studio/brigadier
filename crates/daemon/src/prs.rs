//! The PR watch [D1009, D1017, D1047, D1192]: every published, unarchived session's PRs read on
//! the host's own CLI on a schedule, as VS Code's PR extension polls: every 30 s while
//! checks run, 2 min with a PR open, 5 min otherwise or with no window open (proposed, D1047).
//! Each read keeps `prs.json` in the session's folder, whose change the index publishes on the
//! session's row. It never wakes the agent [D1027].

use super::Shared;
use brigadier_core::{host, ids, session_dir};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

const TICK: Duration = Duration::from_secs(10);
const RUNNING: Duration = Duration::from_secs(30);
const OPEN: Duration = Duration::from_secs(2 * 60);
const QUIET: Duration = Duration::from_secs(5 * 60);

pub(super) fn watch(data: PathBuf, state: Shared) {
    thread::spawn(move || {
        let mut next: HashMap<String, Instant> = HashMap::new();
        loop {
            let ids = ids(&data);
            next.retain(|id, _| ids.contains(id));
            for id in ids {
                if next.get(&id).is_some_and(|at| *at > Instant::now()) {
                    continue;
                }
                let kept = match session_dir(&data, &id).join("archived").exists() {
                    true => None,
                    false => host::pr(&data, &id).ok().and_then(|pr| pr.watch()),
                };
                // A window is open while the app is subscribed.
                let window = !state.lock().unwrap().subs.is_empty();
                next.insert(id, Instant::now() + every(kept.as_ref(), window));
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
