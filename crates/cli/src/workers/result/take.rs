//! The parent's own `wait` takes its worker's result or ask, so it isn't sent again [D3034].

use super::{Res, all, fresh, said, write_ended};
use crate::workers::{link, write_json};
use crate::{owner, queue};
use brigadier_core::{self as core};
use serde_json::json;
use std::path::Path;

/// The parent's own `wait` on its worker takes the result it returns, so it isn't sent again; any
/// other session's wait never does [D3034]. Its text, when there's one to take.
/// `turn` names the exact report turn waited on (a `send --wait`); none takes its latest. Taken
/// under the parent's queue lock, which a delivery holds while it sends [D3006, D3034].
pub fn take(data: &Path, me: &str, wid: &str, turn: Option<&str>) -> Option<String> {
    let _ = write_ended(data, wid, false);
    take_if(data, me, wid, |r| turn.is_none_or(|t| r.turn == t))
}

/// The parent's own `wait` takes its worker's ask as soon as it's written, while the worker still
/// works [D131].
pub fn take_ask(data: &Path, me: &str, wid: &str) -> Option<String> {
    take_if(data, me, wid, |r| r.how == "asks")
}

fn take_if(data: &Path, me: &str, wid: &str, pick: impl Fn(&Res) -> bool) -> Option<String> {
    let l = link(data, wid).filter(|l| l.parent == me)?;
    let _ = crate::workers::asks::asked(data, wid);
    let (_lock, _) = queue::hold(&core::session_dir(data, me)).ok()?;
    let results = all(data, &l.parent);
    let (path, mut res) = (results.iter().rev())
        .find(|(_, r)| r.wid == wid && r.state == "written" && pick(r) && fresh(data, r))
        .cloned()?;
    res.state = "taken".into();
    write_json(&path, &res).ok()?;
    if res.how == "asks" {
        return Some(res.text);
    }
    // Its earlier turns' results go with it, so none wakes the parent after it [D151].
    for (path, mut r) in results
        .into_iter()
        .filter(|(_, r)| r.wid == wid && r.state == "written" && r.how != "asks" && r.at < res.at)
    {
        r.state = "taken".into();
        let _ = write_json(&path, &r);
    }
    let note = json!({"event": "worker", "phase": "result", "result": said(&res)});
    let _ = owner::call(data, me, json!({"op": "note", "data": note}));
    Some(res.text)
}
