//! The daemon's pass for a chat's carry-on at its usage limit's reset [C34, C54].

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

/// Carries a chat on once its usage limit's reset has passed [C34, C54]: its row's `reset.due`
/// against the clock each pass, as a held worker's Wait is [D2028], so a Mac asleep at the reset
/// carries on at its first pass awake, a restart loses nothing and a newer reset replaces an older
/// one. Off the loop, once at a time per chat; the command checks it all again under its fence.
pub fn at_reset(data: &Path, rows: &BTreeMap<String, Value>) {
    static GOING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
    let now = brigadier_frames::log::now_ms();
    let due = |r: &Value| {
        r["state"] == "limited" && r["reset"]["due"].as_u64().is_some_and(|at| at <= now)
    };
    for (id, _) in rows.iter().filter(|(_, r)| due(r)) {
        if !GOING.lock().unwrap().insert(id.clone()) {
            continue;
        }
        let (data, id) = (data.to_path_buf(), id.clone());
        thread::spawn(move || {
            let failed = match brigadier::run(&data, &["reset".into(), id.clone()]) {
                Ok(r) if r["ok"] == true || r["error"] == "not_due" => false,
                Ok(r) => {
                    eprintln!("brigadierd: reset {id}: {}", r["error"]);
                    true
                }
                Err(e) => {
                    eprintln!("brigadierd: reset {id}: {e}");
                    true
                }
            };
            // A refused try (trust, a level) waits a minute before the next, not every pass.
            if failed {
                thread::sleep(Duration::from_secs(60));
            }
            GOING.lock().unwrap().remove(&id);
        });
    }
}
