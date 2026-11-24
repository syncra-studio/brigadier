//! Deleting a session deletes its whole worker family, after one confirm [D3017]. The confirm
//! lists each worker's branch with work that never landed, and one choice keeps them all
//! (uncommitted work committed first, as every delete does) or deletes them too. The delete is
//! recorded under the family's lock first, so no start or result goes into the family after it,
//! and a delete cut short by a crash goes on from its record.

use super::{CLOSING, below, family_lock, make, place, read_json, write_json};
use crate::sessions;
use brigadier_core::{self as core, session};
use serde_json::{Value, json};
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

/// The workers among `ids` whose branch holds work that never landed: what the confirm lists.
pub fn unlanded(data: &Path, ids: &[String]) -> Vec<Value> {
    (ids.iter())
        .filter_map(|id| {
            let spec = core::load(data, id).ok()?;
            let branch = session::unlanded(&spec).ok().flatten()?;
            Some(json!({"id": id, "title": core::share::title(&spec), "branch": branch}))
        })
        .collect()
}

/// `delete <id> [--branch keep|delete]`: its workers, deepest first, then itself. With none,
/// the plain delete.
pub fn delete(data: &Path, id: &str, drop: bool) -> io::Result<Value> {
    let record = core::session_dir(data, id).join(CLOSING);
    let drop = read_json::<Value>(&record).map_or(drop, |r| r["drop"] == true);
    {
        let (root, _) = place(data, id);
        // A worker whose family's root went first is a family of its own.
        let root = Some(root)
            .filter(|r| core::session_dir(data, r).exists())
            .unwrap_or_else(|| id.to_string());
        let _family = family_lock(data, &root)?;
        // Under the lock, so a first start can't slip in between the look and the delete.
        if below(data, id).is_empty() && !record.exists() {
            return sessions::delete(data, id, drop, "delete");
        }
        if !record.exists() {
            write_json(&record, &json!({"drop": drop}))?;
        }
    }
    let (mut kept, mut left) = (vec![], vec![]);
    // A start already being made finishes or fails before its family is counted.
    let started = Instant::now();
    loop {
        let mut family = below(data, id);
        let ids: Vec<String> = family.iter().map(|r| r.wid.clone()).collect();
        if make::making(&ids) && started.elapsed() < Duration::from_secs(30) {
            thread::sleep(Duration::from_millis(100));
            continue;
        }
        family.retain(|r| {
            core::session_dir(data, &r.wid)
                .join("session.json")
                .exists()
        });
        if family.is_empty() {
            break;
        }
        family.sort_by_key(|r| std::cmp::Reverse(r.depth));
        for r in &family {
            match sessions::delete(data, &r.wid, drop, "delete") {
                Ok(reply) => {
                    kept.extend(
                        reply["kept_branches"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .cloned(),
                    );
                    left.extend(reply["left"].as_array().into_iter().flatten().cloned());
                }
                Err(e) => left.push(format!("{}: {e}", r.title).into()),
            }
        }
        if !left.is_empty() {
            return Ok(json!({"ok": false, "kept_branches": kept, "left": left}));
        }
    }
    let mut reply = sessions::delete(data, id, drop, "delete")?;
    if let Some(all) = reply["kept_branches"].as_array_mut() {
        all.extend(kept);
    }
    Ok(reply)
}

/// Once per daemon: a family delete a crash cut short goes on.
pub(super) fn resume(data: &Path) {
    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    for id in core::ids(data) {
        if core::session_dir(data, &id).join(CLOSING).exists() {
            let data = data.to_path_buf();
            thread::spawn(move || {
                if let Err(e) = delete(&data, &id, false) {
                    eprintln!("brigadierd: family delete {id}: {e}");
                }
            });
        }
    }
}
