//! Undo a restore, one deep [D384, D1196]: the restore's record is kept as it lands [D1213], and
//! the toast's Undo restore puts back what it changed, only where each path is still exactly as
//! the restore left it [D1192].

use super::shared::{Lives, sharer};
use super::snap::{Shot, Store};
use super::{Op, checkout_lock, folded, refused};
use crate::{Spec, session, write_atomic};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::Path;

const FILE: &str = "restored.json";

/// The last restore: the folder just before it, where it put the paths, and which.
#[derive(Serialize, Deserialize)]
struct Restored {
    op: String,
    pre: Shot,
    target: String,
    paths: BTreeSet<String>,
}

/// Called as a rewind lands, before its operation is cleared: a restore's record replaces the
/// last one, any other rewind removes it, so Undo only ever reaches the latest.
pub(super) fn keep(spec: &Spec, op: &Op) -> io::Result<()> {
    let path = spec.dir.join(FILE);
    match (&op.pre, &op.target) {
        (Some(pre), Some(target)) if !op.paths.is_empty() => {
            let r = Restored {
                op: op.op.clone(),
                pre: pre.clone(),
                target: target.clone(),
                paths: op.paths.clone(),
            };
            write_atomic(&path, &serde_json::to_vec(&r)?)
        }
        _ => match fs::remove_file(&path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        },
    }
}

/// Puts `paths` back as `pre` has them, each only where it's still exactly as `target` has it:
/// one changed since, unreadable, kept out of snapshots or that a write would go through stays,
/// and is returned [D1078, D1192].
pub(super) fn put_back(
    store: &Store,
    pre: &str,
    target: &str,
    paths: &BTreeSet<String>,
) -> io::Result<Vec<String>> {
    let held: BTreeSet<String> = (paths.iter())
        .filter(|p| store.holds(target, p))
        .cloned()
        .collect();
    let back: BTreeSet<String> = (held.iter())
        .filter(|p| !store.blocked(p, &held))
        .cloned()
        .collect();
    store.write_back(pre, &back)?;
    Ok(paths.difference(&back).cloned().collect())
}

/// Undoes the restore that rewind `op` made, under the fence a turn start takes and the exclusive
/// checkout lock [D1089]. Refused while this session's turn or background work runs, or another
/// session works in the folder.
pub fn undo_restore(data: &Path, spec: &Spec, op: &str, live: Lives) -> io::Result<Value> {
    let (fence, mut checkout) = session::fence(data, spec)?;
    let _fence = fence;
    // Exchanged, as `apply` does: the exclusive lock would wait on this process's shared one.
    checkout.take();
    let _exclusive = checkout_lock(data, true)?;
    Ok(run(data, spec, op, live).unwrap_or_else(|e| e))
}

fn run(data: &Path, spec: &Spec, op: &str, live: Lives) -> Result<Value, Value> {
    let path = spec.dir.join(FILE);
    let gone = || refused("gone", "This restore can't be undone any more.");
    let r: Restored = (fs::read(&path).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .filter(|r: &Restored| r.op == op)
        .ok_or_else(gone)?;
    let f = folded(spec)?;
    if !f.turns.is_empty() {
        return Err(refused("running", "Stop the turn or let it finish first."));
    }
    if live(spec, &f).jobs > 0 {
        return Err(refused(
            "jobs",
            "Background work from this session is still running. Stop it first.",
        ));
    }
    let store = Store::of(spec).ok_or_else(gone)?;
    // With no turns of its own to weigh, only a sharer working now is named.
    if let Some((_, with)) = sharer(data, spec, &store, &[], live) {
        let name = (crate::load(data, &with).ok()).map_or("Another session".into(), |o| {
            crate::share::title(&o).to_string()
        });
        return Err(refused(
            "busy",
            format!("Files stay: {name} is working in this folder now."),
        ));
    }
    let kept = put_back(&store, &r.pre.tree, &r.target, &r.paths)
        .map_err(|e| refused("failed", format!("The restore couldn't be undone: {e}")))?;
    // One deep: gone once used. Left behind, a second Undo finds every path changed and keeps it.
    let _ = fs::remove_file(&path);
    Ok(json!({"ok": true, "undone": r.paths.len() - kept.len(), "kept": kept}))
}
