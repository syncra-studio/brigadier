//! What the parent hears of the user's own messages to its worker [D293, D294, D303, D304]: one
//! line per message (its first 200 characters, at most 5 a worker at a time) and, when a turn the
//! user started ends, a result of at most 1 KB. Neither wakes the parent: they go with its next
//! input (the user's message, a worker's result) or its own `wait` on that worker, oldest first,
//! never the worker's thread. Each is a record in the parent's `results/`, `quiet` till it goes,
//! found from the worker's own log, so no way of sending misses one. One that went names the
//! parent's input it went with, and is taken once the parent's log has that input: a crash
//! mid-send neither loses nor repeats it [D54].

use super::{Res, all, dir_of, path_of};
use crate::workers::{Link, link, row::clock, write_json};
use crate::{owner, queue};
use brigadier_core::{self as core};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

/// The most of one worker's messages a note lists; the rest are counted.
const MOST: usize = 5;

/// Each worker's row last looked at, so a pass folds only one whose log changed.
static SEEN: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);

/// The daemon's pass for a worker: each direct message its log has gets its record, once, and
/// its "You messaged ‹name›" row in the parent's thread [D303].
pub(super) fn scan(data: &Path, wid: &str, row: &Value) {
    let at = json!([row["updated"], row["items"]]);
    if SEEN
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(wid.into(), at.clone())
        == Some(at)
    {
        return;
    }
    let Some(l) = link(data, wid) else {
        return;
    };
    let Ok(f) = core::fold(&core::session_dir(data, wid), true) else {
        return;
    };
    for d in &f.fold.direct {
        let cid = d["cid"].as_str().unwrap_or_default();
        let path = path_of(data, &l.parent, wid, &format!("m{cid}"));
        if cid.is_empty() || path.exists() {
            continue;
        }
        let text = d["text"].as_str().unwrap_or_default().to_string();
        let res = Res {
            wid: wid.into(),
            turn: format!("m{cid}"),
            how: "told".into(),
            text: text.clone(),
            at: d["ts"].as_u64().unwrap_or_default(),
            state: "quiet".into(),
            ..Default::default()
        };
        // Its row first, the parent's host started for it; the record once the row is in, so a
        // crash between repeats the row at worst, never the parent's line. Not in: next pass.
        let note = json!({"event": "worker", "phase": "messaged", "ids": [wid], "text": text});
        let shown = core::load(data, &l.parent)
            .and_then(|spec| owner::ensure(data, &spec))
            .and_then(|_| owner::call(data, &l.parent, json!({"op": "note", "data": note})));
        let kept = shown.and_then(|_| fs::create_dir_all(dir_of(data, &l.parent)));
        if kept.and_then(|()| write_json(&path, &res)).is_err() {
            SEEN.lock().unwrap().as_mut().map(|s| s.remove(wid));
        }
    }
}

/// The turns the user started in the worker, each followed to the switch or rebirth that carries
/// it on, as `reported` does: their ends report quietly.
pub(super) fn turns(f: &core::fold::Fold) -> Vec<String> {
    let started = f.direct.iter().filter(|d| d["steer"] != true);
    let mut out: Vec<String> = started
        .filter_map(|d| d["cid"].as_str().map(String::from))
        .collect();
    for t in &mut out {
        while let Some(next) = f.carried.get(t) {
            *t = next.clone();
        }
    }
    out
}

/// The records still to go to `pid` (of `wid` alone, when named): one that went with an input the
/// parent's log now has is taken.
fn due(data: &Path, pid: &str, wid: Option<&str>) -> Vec<(std::path::PathBuf, Res)> {
    let mut due = all(data, pid);
    due.retain(|(_, r)| r.state == "quiet" && wid.is_none_or(|w| r.wid == w));
    if due.iter().any(|(_, r)| !r.going.is_empty()) {
        let f = core::fold(&core::session_dir(data, pid), true).map(|f| f.fold);
        let cids = f.map(|f| f.cids).unwrap_or_default();
        due.retain_mut(|(path, r)| {
            let took = cids.contains_key(&r.going);
            if took {
                r.state = "taken".into();
                let _ = write_json(path, r);
            }
            !took
        });
    }
    due
}

/// The words for the parent: per worker, its messages then its turns' ends, oldest worker first.
fn words(data: &Path, due: &[(std::path::PathBuf, Res)]) -> String {
    let mut wids: Vec<&str> = Vec::new();
    for (_, r) in due {
        if !wids.contains(&r.wid.as_str()) {
            wids.push(&r.wid);
        }
    }
    let mut out = String::new();
    for wid in wids {
        let title = link(data, wid)
            .map(|l: Link| l.title)
            .unwrap_or_else(|| wid.into());
        let said: Vec<&Res> = due
            .iter()
            .map(|(_, r)| r)
            .filter(|r| r.wid == wid && r.how == "told")
            .collect();
        if !said.is_empty() {
            out += &format!(
                "\n\nThe user messaged your worker {title} ({wid}) directly, in its tab. Not addressed to you; no action unless it changes your plan:"
            );
            for r in said.iter().take(MOST) {
                let cut = if r.text.chars().count() >= 200 {
                    "…"
                } else {
                    ""
                };
                out += &format!("\n- {} \"{}{cut}\"", clock(r.at), r.text.trim());
            }
            if said.len() > MOST {
                out += &format!(
                    "\n- …and {} more: `brigadier read {wid}`",
                    said.len() - MOST
                );
            }
        }
        for r in due
            .iter()
            .map(|(_, r)| r)
            .filter(|r| r.wid == wid && r.how != "told")
        {
            out += &format!("\n\n{}", r.text);
        }
    }
    out
}

/// What goes with the parent's input `cid` (its user's message, a worker's result): each record
/// marked with it first, then the words, after `agent`'s. Call under the parent's queue lock.
pub fn with(data: &Path, pid: &str, cid: &str, agent: &mut String) {
    let mut due = due(data, pid, None);
    for (path, r) in due.iter_mut() {
        r.going = cid.into();
        let _ = write_json(path, r);
    }
    *agent += &words(data, &due);
}

/// The parent's own `wait` on worker `wid` takes what waits from it at once, though it still
/// works [D304]; under the parent's queue lock, as a delivery sends.
pub fn take(data: &Path, me: &str, wid: &str) -> Option<String> {
    link(data, wid).filter(|l| l.parent == me)?;
    let (_lock, _) = queue::hold(&core::session_dir(data, me)).ok()?;
    let due = due(data, me, Some(wid));
    if due.is_empty() {
        return None;
    }
    for (path, mut r) in due.iter().cloned() {
        r.state = "taken".into();
        write_json(&path, &r).ok()?;
    }
    Some(words(data, &due).trim_start().to_string())
}

/// Resume's continue reports what a Pause stopped: each turn the user started that ended without
/// a result is dropped, so it never reads later as finished [D3041].
pub(in crate::workers) fn paused(data: &Path, l: &Link, wid: &str) -> std::io::Result<()> {
    let f = core::fold(&core::session_dir(data, wid), true)?.fold;
    let ended = |t: &String| f.cids.contains_key(t) && !f.turns.iter().any(|x| &x.id == t);
    for turn in turns(&f).iter().filter(|t| ended(t)) {
        let path = path_of(data, &l.parent, wid, turn);
        if path.exists() {
            continue;
        }
        let (how, state, at) = (
            "stopped".into(),
            "dropped".into(),
            brigadier_frames::log::now_ms(),
        );
        let res = Res {
            wid: wid.into(),
            turn: turn.clone(),
            how,
            state,
            at,
            ..Default::default()
        };
        fs::create_dir_all(dir_of(data, &l.parent))?;
        write_json(&path, &res)?;
    }
    Ok(())
}
