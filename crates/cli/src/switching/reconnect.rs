//! Brigadier's resume of a turn the network cut [D339]: the daemon asks here once the agent's API
//! answers again, and the user's Try again past the tries asks with `--now`. Under the session's
//! fence, and only while that try is due, so a message the user sent meanwhile is the resume.

use crate::{owner, workers};
use brigadier_core::{self as core, fold};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

pub fn run(data: &Path, id: &str, now: bool) -> io::Result<Value> {
    let spec = core::load(data, id)?;
    owner::ensure(data, &spec)?;
    crate::rewind::settled(data, &spec)?;
    let _fence = core::session::fence(data, &spec)?;
    let f = core::fold(&spec.dir, true)?.fold;
    let Some(due) = fold::reconnect(&f, now) else {
        return Ok(json!({"ok": false, "error": "not_due"}));
    };
    // A worker's cut turn would have reported to its parent: the resume's end does instead.
    let (turn, cid) = (
        due["turn"].as_str().unwrap_or(""),
        due["cid"].as_str().unwrap_or(""),
    );
    let link = workers::link(data, id).filter(|l| l.report.iter().any(|r| r == turn));
    let report = |from: &str, to: &str| match link.clone() {
        Some(mut l) => {
            l.report.retain(|r| r != from);
            l.report.push(to.into());
            workers::write_json(&spec.dir.join("worker.json"), &l)
        }
        None => Ok(()),
    };
    report(turn, cid)?;
    let call = crate::call_fn(data, id);
    let spec = crate::routing::told(data, &spec);
    let reply = core::reconnect(&spec, &f, crate::child(data, id), &call, now);
    if !matches!(reply["result"].as_str(), Some("delivered" | "logged")) {
        report(cid, turn)?;
    }
    Ok(reply)
}
