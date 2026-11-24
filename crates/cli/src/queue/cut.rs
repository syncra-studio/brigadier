//! A cut-off run, its host or agent dead mid-turn: it waits for the user [D237], but a worker's
//! goes on with the next message of the session that started it, its one carry-on, whether or not
//! the user's Resume comes at the same moment.

use super::{Queue, go_on, hold, locked, read};
use crate::{owner, workers};
use brigadier_core::fold::{self, Fold, Owner};
use brigadier_core::{self as core};
use brigadier_frames::procs;
use serde_json::{Value, json};
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

/// Whether `origin` is the session that started worker `dir`, which isn't a Brigade's sub-session.
pub(super) fn parents(dir: &Path, origin: Option<&str>) -> bool {
    let from = origin.and_then(|o| o.strip_prefix("peer:"));
    from.is_some_and(|from| link(dir).is_some_and(|l| !l.session && l.parent == from))
}

/// Whether a message by `origin` carries worker `dir`'s cut-off run on now.
pub(super) fn carries(dir: &Path, origin: Option<&str>) -> bool {
    parents(dir, origin) && link(dir).is_some_and(|l| !l.paused)
}

/// Whether a cut-off run is about to go on with a message that waits in its queue.
pub fn goes_on(data: &Path, id: &str) -> bool {
    let dir = core::session_dir(data, id);
    read(&dir).is_ok_and(|q| {
        let first = first(&dir, &q).map(|at| &q.items[at]);
        !q.paused && first.is_some_and(|i| i.error.is_none() && carries(&dir, i.origin.as_deref()))
    })
}

/// The first message waiting from the session that started it.
fn first(dir: &Path, q: &Queue) -> Option<usize> {
    let parents = |i: &super::Item| i.to.is_none() && parents(dir, i.origin.as_deref());
    q.items.iter().position(parents)
}

/// Whether a Stop has a worker's cut-off run to log it on.
pub(super) fn stoppable(data: &Path, id: &str) -> bool {
    let worker = link(&core::session_dir(data, id)).is_some_and(|l| !l.session);
    worker && off(data, id).unwrap_or(false)
}

/// Whether the cut-off run was stopped since.
pub(super) fn stopped(f: &Fold) -> bool {
    let last = f.last.as_ref().filter(|_| f.turns.is_empty());
    last.is_some_and(|l| l["outcome"] == "interrupted" && l["halted"] == true)
}

/// Rust's one recovery for a session; `queued`: the caller holds its queue's lock. A cut-off
/// worker with its parent's message waiting goes on with that message alone.
pub fn recover(data: &Path, id: &str, queued: bool) -> io::Result<Value> {
    let spec = core::load(data, id)?;
    owner::ensure(data, &spec)?;
    let _lock = (!queued).then(|| hold(&spec.dir)).transpose()?;
    crate::rewind::settle_held(data, &spec)?;
    if !queued && off(data, id)? {
        let cid = locked(&spec.dir, |q| {
            Ok(first(&spec.dir, q).map(|at| {
                go_on(q);
                q.items[at].error = None;
                q.items[at].id.clone()
            }))
        })?;
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
