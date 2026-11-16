//! The parent's own `wait` takes its worker's result or ask, so it isn't sent again [D3034]; its
//! next message takes those held for it [D329].

use super::{Res, all, fresh, path_of, write, write_ended};
use crate::workers::{Link, link, read_json, write_json};
use crate::{owner, queue};
use brigadier_core::{self as core, fold::Fold};
use serde_json::json;
use std::path::{Path, PathBuf};

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

/// The results held for the parent's next message, or waiting to wake it, go with that message,
/// after its text: one turn, one answer, never a wake per worker [D95, D314, D329]. Ones the user
/// ended come last, the agent told to mention them only if something matters [D330]. Call under
/// the parent's queue lock; `went_with` once the message is in.
pub fn with_next(data: &Path, pid: &str, agent: &mut String) -> Vec<PathBuf> {
    let mut due: Vec<(PathBuf, Res)> = (all(data, pid).into_iter())
        .filter(|(_, r)| matches!(r.state.as_str(), "held" | "written") && r.how != "asks")
        .collect();
    due.sort_by_key(|(_, r)| r.ended);
    for (_, r) in due.iter().filter(|(_, r)| !r.ended) {
        *agent += &format!("\n\n{}", r.text);
    }
    if due.iter().any(|(_, r)| r.ended) {
        *agent += "\n\nThe user ended these workers. Mention them only if something matters (say, a file one left uncommitted), in one short line of your reply:";
        for (_, r) in due.iter().filter(|(_, r)| r.ended) {
            *agent += &format!("\n\n{}", r.text);
        }
    }
    due.into_iter().map(|(path, _)| path).collect()
}

/// The message they went with is in: taken, each with its sentence but one the user ended,
/// whose "You ended" line already says it [D97, D330].
pub fn went_with(data: &Path, pid: &str, taken: Vec<PathBuf>) {
    for (path, mut r) in taken
        .into_iter()
        .filter_map(|p| Some((p.clone(), read_json::<Res>(&p)?)))
    {
        r.state = "taken".into();
        let _ = write_json(&path, &r);
        if !r.ended {
            let note = json!({"event": "worker", "phase": "result", "result": said(&r)});
            let _ = owner::call(data, pid, json!({"op": "note", "data": note}));
        }
    }
}

/// How a result ended, as its parent's thread reads it: `<how>:<worker>[:merged=<base>|:unmerged=<base>]`.
pub(super) fn said(r: &Res) -> String {
    match r.merge.as_str() {
        "" => format!("{}:{}", r.how, r.wid),
        m => format!("{}:{}:{m}", r.how, r.wid),
    }
}

/// The hop a result carries, by its command id in the parent.
pub fn hop(data: &Path, pid: &str, id: &str) -> Option<u64> {
    all(data, pid)
        .into_iter()
        .find(|(_, r)| r.id == id)
        .map(|(_, r)| r.hop)
}

/// The turns a worker reports, each one a limit switch carried on followed to the switch's own
/// input, as its log says [D2041]: what a crash before `worker.json` moved can't lose.
pub fn reported<'a>(l: &'a Link, f: &'a Fold) -> Vec<String> {
    let on = |mut t: &'a String| {
        // Each switch's input is newer than the turn it carries on: this ends.
        while let Some(next) = f.carried.get(t) {
            t = next;
        }
        t.clone()
    };
    l.report.iter().map(on).collect()
}

/// Whether a turn it reports is still on its way or running.
pub fn going(l: &Link, f: &Fold) -> bool {
    (reported(l, f).iter()).any(|t| !f.cids.contains_key(t) || f.turns.iter().any(|x| &x.id == t))
}

/// Whether each turn it reports has its result written.
pub fn told(data: &Path, pid: &str, wid: &str, l: &Link) -> bool {
    let f = core::fold(&core::session_dir(data, wid), true).map(|f| f.fold);
    f.is_ok_and(|f| (reported(l, &f).iter()).all(|t| path_of(data, pid, wid, t).exists()))
}

/// A held worker the user ended before it ever ran: its one result, quiet as any the user ended,
/// with the parent's next turn [D364, D314, D330].
pub fn unrun(data: &Path, wid: &str) -> std::io::Result<()> {
    let Some(l) = link(data, wid).filter(|l| l.last["by"] == "user") else {
        return Ok(());
    };
    match l.report.first() {
        Some(turn) if !path_of(data, &l.parent, wid, turn).exists() => {
            let e = Some("the user ended it while it was held.");
            write(data, &l, wid, turn, "stopped", e)
        }
        _ => Ok(()),
    }
}

/// A temporary failure's line in its result: the parent may run it again [D340] (proposed words).
pub(super) fn retry(wid: &str, why: &str) -> String {
    format!(
        "It failed for a temporary reason ({why}): `brigadier start --retry {wid} \"<what failed>\"` runs it again on the same pick.\n"
    )
}
