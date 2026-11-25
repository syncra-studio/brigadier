//! A cut-off run, its host or agent dead mid-turn: it waits for the user [D237], but a worker's
//! goes on with the next message of the session that started it, its one carry-on, whether or not
//! the user's Resume comes at the same moment.

use super::{Queue, go_on, hold, locked, read};
use crate::{owner, peers, workers};
use brigadier_core::fold::{self, Fold, Owner};
use brigadier_core::{self as core};
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::fs::File;
use std::io;
use std::path::Path;

/// Its fold and state now.
pub(super) fn now(data: &Path, id: &str) -> io::Result<(Fold, String)> {
    let dir = core::session_dir(data, id);
    let f = core::fold(&dir, true)?.fold;
    let live = fold::live(&f, owner::state(data, id), &dir, &procs::all());
    let state = fold::status(&f, &live)["state"].as_str().map(String::from);
    Ok((f, state.unwrap_or_default()))
}

/// Whether its last run was cut off and nothing carried it on.
pub fn off(data: &Path, id: &str) -> io::Result<bool> {
    Ok(now(data, id)?.1 == "interrupted")
}

pub(super) fn link(dir: &Path) -> Option<workers::Link> {
    workers::read_json(&dir.join("worker.json"))
}

/// Whether `origin` is the session that started worker `dir`.
pub(super) fn parents(dir: &Path, origin: Option<&str>) -> bool {
    let from = origin.and_then(|o| o.strip_prefix("peer:"));
    from.is_some_and(|from| link(dir).is_some_and(|l| l.parent == from))
}

/// Whether its agent had announced a conversation to go on in: cut off before, a message alone
/// would start one without its brief.
pub(super) fn begun(f: &Fold) -> bool {
    f.resume.contains_key(&f.backend)
}

/// Whether a message by `origin` carries worker `dir`'s cut-off run on now.
pub(super) fn carries(dir: &Path, f: &Fold, origin: Option<&str>) -> bool {
    begun(f) && parents(dir, origin) && link(dir).is_some_and(|l| !l.paused)
}

/// Whether a cut-off run is about to go on with a message that waits in its queue.
pub fn goes_on(data: &Path, id: &str) -> bool {
    let dir = core::session_dir(data, id);
    let Ok((q, (f, _))) = read(&dir).and_then(|q| Ok((q, now(data, id)?))) else {
        return false;
    };
    let first = first(&dir, &q).map(|at| &q.items[at]);
    !q.paused && first.is_some_and(|i| i.error.is_none() && carries(&dir, &f, i.origin.as_deref()))
}

/// The first message waiting from the session that started it.
fn first(dir: &Path, q: &Queue) -> Option<usize> {
    let parents = |i: &super::Item| i.to.is_none() && parents(dir, i.origin.as_deref());
    q.items.iter().position(parents)
}

/// Whether a Stop has a worker's cut-off run to log it on.
pub(super) fn stoppable(data: &Path, id: &str) -> bool {
    link(&core::session_dir(data, id)).is_some() && off(data, id).unwrap_or(false)
}

/// Whether the cut-off run was stopped since.
pub(super) fn stopped(f: &Fold) -> bool {
    let last = f.last.as_ref().filter(|_| f.turns.is_empty());
    last.is_some_and(|l| l["outcome"] == "interrupted" && l["halted"] == true)
}

/// Whether a Resume carries a cut-off worker's stopped run on by itself: no message waits to.
pub(super) fn resumes(dir: &Path, f: &Fold, state: &str, q: &Queue) -> bool {
    let waiting = first(dir, q).is_some() && begun(f);
    state == "interrupted" && stopped(f) && !waiting && link(dir).is_some_and(|l| !l.paused)
}

/// Holds its queue for a Resume, once what a cut-off worker's parent has sent is in it, though it
/// waited for the same lock: the ids of those.
pub(super) fn hold_all(data: &Path, id: &str) -> io::Result<(File, Vec<String>)> {
    let dir = core::session_dir(data, id);
    let lock = hold(&dir)?.0;
    let Some(l) = link(&dir) else {
        return Ok((lock, vec![]));
    };
    let sent = match off(data, id)? {
        true => peers::written(data, &l.parent, id),
        false => vec![],
    };
    if sent.is_empty() {
        return Ok((lock, sent));
    }
    drop(lock);
    peers::hand_all(data, &l.parent, &sent);
    Ok((hold(&dir)?.0, sent))
}

/// Rust's one recovery for a session; `queued`: the caller holds its queue's lock. A cut-off
/// worker with its parent's message waiting goes on with that message alone.
pub fn recover(data: &Path, id: &str, queued: bool) -> io::Result<Value> {
    let spec = core::load(data, id)?;
    owner::ensure(data, &spec)?;
    let lock = (!queued).then(|| hold_all(data, id)).transpose()?;
    crate::rewind::settle_held(data, &spec)?;
    if let Some((_, handed)) = &lock {
        let (f, state) = now(data, id)?;
        // One may have carried it on since it was handed over.
        let mut cid = (handed.iter().find(|mid| f.cids.contains_key(*mid))).cloned();
        if state == "interrupted" && begun(&f) {
            cid = locked(&spec.dir, |q| {
                Ok(first(&spec.dir, q).map(|at| {
                    go_on(q);
                    q.items[at].error = None;
                    q.items[at].id.clone()
                }))
            })?;
        }
        if let Some(cid) = cid {
            return Ok(json!({"ok": true, "result": "queued", "recovered": "queued", "cid": cid}));
        }
    }
    let _fence = core::session::fence(data, &spec)?;
    let f = core::fold(&spec.dir, true)?;
    let live = fold::live(&f.fold, Owner::Alive, &spec.dir, &procs::all());
    let call = crate::call_fn(data, id);
    // The user's Resume takes what's held for the session, as their next message would [D329].
    let mut more = String::new();
    let held = match queued {
        true => workers::with_next(data, id, None, &mut more),
        false => vec![],
    };
    let spec = crate::routing::told(data, &spec);
    let reply = core::recover(&spec, &f.fold, &live, crate::child(data, id), &call, &more);
    if matches!(reply["result"].as_str(), Some("delivered" | "logged")) {
        workers::went_with(data, id, held);
    }
    Ok(reply)
}
