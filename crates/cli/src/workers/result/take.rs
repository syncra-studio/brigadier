//! The parent's own `wait` takes its worker's result or ask, so it isn't sent again [D3034]; its
//! next message takes those held for it [D329].

use super::{Res, all, fresh, holds, path_of, unsaid, unsent, woken, write, write_ended};
use crate::workers::{Link, link, read_json, write_json};
use crate::{owner, queue};
use brigadier_core::{self as core, fold::Fold};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// The parent's own `wait` on its worker takes the result it returns, so it isn't sent again; any
/// other session's wait never does [D3034]. Its text, when there's one to take.
/// `turn` names the exact report turn waited on (a `send --wait`); none takes its latest. Taken
/// under the parent's queue lock, which a delivery holds while it sends [D3006, D3034].
/// `cut`: its host died, so a turn it left open ended too, failed.
pub fn take(data: &Path, me: &str, wid: &str, turn: Option<&str>, cut: bool) -> Option<String> {
    let _ = write_ended(data, wid, cut);
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
    let due = |r: &Res| r.wid == wid && r.state == "written";
    let at = (results.iter()).rposition(|(_, r)| due(r) && pick(r) && fresh(data, r))?;
    let (path, mut res) = results[at].clone();
    res.state = "taken".into();
    write_json(&path, &res).ok()?;
    if res.how == "asks" {
        return Some(res.text);
    }
    // Its earlier results go with it, oldest first, so none wakes the parent after it [D151].
    let mut took = vec![];
    for (path, mut r) in results.into_iter().take(at) {
        if due(&r) && r.how != "asks" {
            r.state = "taken".into();
            if write_json(&path, &r).is_ok() {
                took.push(r);
            }
        }
    }
    took.push(res);
    for r in &took {
        let note = json!({"event": "worker", "phase": "result", "result": said(data, me, r)});
        let _ = owner::call(data, me, json!({"op": "note", "data": note}));
    }
    let texts: Vec<String> = took.into_iter().map(|r| r.text).collect();
    Some(texts.join("\n\n"))
}

/// The results held for the parent's next message, or waiting to wake it, go with that message,
/// after its text: one turn, one answer, never a wake per worker [D95, D314, D329]. Ones the user
/// or the parent ended come last, the agent told to mention them only if something matters [D330]. Call under
/// the parent's queue lock; `went_with` once the message is in.
/// `cid`: the message's own id, which what the user told its workers goes with first, as it came
/// first [D303]; a Resume's, unknown here, takes none.
pub fn with_next(data: &Path, pid: &str, cid: Option<&str>, agent: &mut String) -> Vec<PathBuf> {
    if let Some(cid) = cid {
        super::told::with(data, pid, cid, agent);
    }
    let mut due: Vec<(PathBuf, Res)> = (all(data, pid).into_iter())
        .filter(|(_, r)| matches!(r.state.as_str(), "held" | "written") && r.how != "asks")
        .collect();
    due.sort_by_key(|(_, r)| r.ended);
    // One that waited on a refusal: its row says delivered once this message is proven taken.
    for (path, r) in due.iter_mut().filter(|(_, r)| !r.refused.is_empty()) {
        r.going = cid.unwrap_or_default().into();
        let _ = write_json(path, r);
    }
    for (_, r) in due.iter().filter(|(_, r)| !r.ended) {
        *agent += &format!("\n\n{}", r.text);
    }
    if due.iter().any(|(_, r)| r.ended) {
        *agent += "\n\nThese workers were ended, by the user or by you. Mention them only if something matters (say, a file one left uncommitted), in one short line of your reply:";
        for (_, r) in due.iter().filter(|(_, r)| r.ended) {
            *agent += &format!("\n\n{}", r.text);
        }
    }
    due.into_iter().map(|(path, _)| path).collect()
}

/// The message they went with is in: taken, each with its sentence but one the user ended,
/// whose "You ended" line already says it [D97, D330].
pub fn went_with(data: &Path, pid: &str, taken: Vec<PathBuf>) {
    let mut results = vec![];
    for (path, mut r) in taken
        .into_iter()
        .filter_map(|p| Some((p.clone(), read_json::<Res>(&p)?)))
    {
        r.state = "taken".into();
        if !r.refused.is_empty() {
            unsent::on_way(data, pid, &r);
            // A Resume's input is unknown here: on its way is all its row says.
            if r.going.is_empty() {
                r.refused.clear();
            }
        }
        let _ = write_json(&path, &r);
        results.push(r);
    }
    for r in results.iter().filter(|r| !r.ended) {
        let note = json!({"event": "worker", "phase": "result", "result": said(data, pid, r)});
        let _ = owner::call(data, pid, json!({"op": "note", "data": note}));
    }
}

/// How a result ended, as its parent's thread reads it: `<how>:<worker>[:merged=<base>|:unmerged=<base>]`,
/// then `:open` while a later task of that worker is open, so this one doesn't end the wait on it,
/// or `:wakes` while work it left running can wake it, which its parent waits on again.
pub(super) fn said(data: &Path, pid: &str, r: &Res) -> String {
    let wakes =
        || core::fold(&core::session_dir(data, &r.wid), true).is_ok_and(|f| super::wakes(&f.fold));
    // One its host's death ended has nothing left to wait on.
    let more =
        r.how != "asks" && r.end != u64::MAX && link(data, &r.wid).is_some_and(|l| !l.paused);
    let tail = match more {
        true if !crate::workers::over_but(data, pid, &r.wid, &r.id) => ":open",
        true if wakes() => ":wakes",
        _ => "",
    };
    let merge = match r.merge.as_str() {
        "" => String::new(),
        m => format!(":{m}"),
    };
    format!("{}:{}{merge}{tail}", r.how, r.wid)
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

/// Whether a turn `wid` reports is still on its way or running, or ended with its result held
/// for its background work, or a wake carries it on. `direct`: or one the user started in it has.
pub fn going(data: &Path, wid: &str, l: &Link, f: &Fold, direct: bool) -> bool {
    let held =
        |t: &String| holds(f, t) && (woken(f, t) || !path_of(data, &l.parent, wid, t).exists());
    (reported(l, f).iter()).any(|t| match f.cids.contains_key(t) {
        true => f.turns.iter().any(|x| &x.id == t) || held(t),
        false => !off(data, wid, t),
    }) || (direct && super::told::turns(f).iter().any(held))
}

/// Whether each turn it reports has its result written, and each wake that carried one on.
pub fn told(data: &Path, pid: &str, wid: &str, l: &Link) -> bool {
    let f = core::fold(&core::session_dir(data, wid), true).map(|f| f.fold);
    let told = |f: &Fold, t: &String| match f.cids.contains_key(t) {
        true => {
            path_of(data, pid, wid, t).exists()
                && unsaid(data, l, wid, f, t, false, false).is_empty()
        }
        false => off(data, wid, t),
    };
    f.is_ok_and(|f| reported(l, &f).iter().all(|t| told(&f, t)))
}

/// Whether the message a turn would start with isn't on its way: removed from the worker's queue,
/// or waiting in one the user's Stop holds. Nothing waits on it till it goes.
fn off(data: &Path, wid: &str, turn: &str) -> bool {
    let dir = core::session_dir(data, wid);
    let held = || queue::pending(&dir, turn) && queue::row(&dir)["paused"] == true;
    let rec = dir.join("peers/in").join(format!("{turn}.json"));
    held() || read_json::<Value>(&rec).is_some_and(|r| r["state"] == "dropped")
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
