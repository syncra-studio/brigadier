//! Undo a restore, one deep [D384, D1196]: the restore's record is kept as it lands [D1213], and
//! the toast's Redo file changes puts back what it changed, only where each path is still exactly as
//! the restore left it [D1192].

use super::repos::Part;
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
    /// None for a folder chat's, whose own folder isn't a repo [D3105].
    pre: Option<Shot>,
    target: Option<String>,
    paths: BTreeSet<String>,
    #[serde(default)]
    repos: Vec<Part>,
}

/// A rewind that landed: a restore's record replaces the last one, any other rewind removes it, so
/// Undo only ever reaches the latest; then its operation goes, never before [D1213].
pub(super) fn close(spec: &Spec, op: &Op) -> io::Result<()> {
    let path = spec.dir.join(FILE);
    let main = op.pre.is_some() && op.target.is_some() && !op.paths.is_empty();
    match main || !op.repos.is_empty() {
        true => {
            let r = Restored {
                op: op.op.clone(),
                pre: op.pre.clone(),
                target: op.target.clone(),
                paths: op.paths.clone(),
                repos: op.repos.clone(),
            };
            write_atomic(&path, &serde_json::to_vec(&r)?)
        }
        _ => match fs::remove_file(&path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        },
    }?;
    super::clear(spec)
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
    let gone = || {
        refused(
            "gone",
            "Only the last rewind's changes can be put back, once.",
        )
    };
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
    let store = Store::of(spec).filter(|_| r.target.is_some());
    if store.is_none() && r.target.is_some() {
        return Err(gone());
    }
    // With no turns of its own to weigh, only a sharer working now is named.
    let here =
        (store.as_ref()).and_then(|s| sharer(data, spec, s, &[], live).map(|(_, with)| with));
    if let Some(with) = here.or_else(|| super::repos::busy(data, spec, &r.repos, live)) {
        let name = (crate::load(data, &with).ok()).map_or("Another session".into(), |o| {
            crate::share::title(&o).to_string()
        });
        return Err(refused(
            "busy",
            format!("Files stay: {name} is working in this folder now."),
        ));
    }
    let mine = match (&store, &r.pre, &r.target) {
        (Some(store), Some(pre), Some(target)) => put_back(store, &pre.tree, target, &r.paths),
        _ => Ok(vec![]),
    };
    let kept = (mine.and_then(|mut kept| {
        kept.extend(super::repos::put_back(spec, &r.repos)?);
        Ok(kept)
    }))
    .map_err(|e| refused("failed", e.to_string()))?;
    // One deep: gone once used. Left behind, a second Undo finds every path changed and keeps it.
    let _ = fs::remove_file(&path);
    let all = r.paths.len() + super::repos::named(&r.repos).len();
    Ok(json!({"ok": true, "undone": all - kept.len(), "kept": kept}))
}
