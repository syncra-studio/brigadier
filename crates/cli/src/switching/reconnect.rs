//! Brigadier's resume of a turn the network cut [D339]: the daemon asks here once the agent's API
//! answers again, and the user's Try again past the tries asks with `--now`. Under the session's
//! fence, and only while that try is due, so a message the user sent meanwhile is the resume.

use crate::owner;
use brigadier_core as core;
use serde_json::Value;
use std::io;
use std::path::Path;

pub fn run(data: &Path, id: &str, now: bool) -> io::Result<Value> {
    let spec = core::load(data, id)?;
    owner::ensure(data, &spec)?;
    crate::rewind::settled(data, &spec)?;
    let _fence = core::session::fence(data, &spec)?;
    let f = core::fold(&spec.dir, true)?.fold;
    let call = crate::call_fn(data, id);
    let spec = crate::routing::told(data, &spec);
    // A worker reports the resume's end: its fold carries the cut turn on to it.
    Ok(core::reconnect(
        &spec,
        &f,
        crate::child(data, id),
        &call,
        now,
    ))
}
