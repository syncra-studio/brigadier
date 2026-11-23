//! A worker's result [D3006]: when a task it reports back on ends, Rust writes how it ended, its
//! last message, its branch and commits, then delivers it into the parent once, on the delivery
//! rules [D54, D82, D237]: written first in the parent's `results/`, sent under its own id with the
//! parent between turns and its queue empty, done once the parent's log proves the agent took it.
//! Logged without that proof, it's uncertain and never sent again by itself. An idle parent wakes;
//! a busy one gets it after its turn. Turns the user starts in a worker report nothing.

mod images;
mod report;
mod take;

use super::review;
use super::{Link, Record, closing, link, read_json, write_json};
use crate::{owner, queue};
use brigadier_core::fold::{self, Owner};
use brigadier_core::{self as core};
use brigadier_frames::procs;
pub(super) use report::write;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use take::said;
pub use take::{going, hop, reported, take, take_ask, told, unrun, went_with, with_next};

/// The most of its last message a result carries [D3006].
const LAST: usize = 16 << 10;

/// The states a parent takes a result in: between turns, as the queue's.
const TAKES: [&str; 4] = ["idle", "idle_jobs", "stopped", "failed"];

#[derive(Serialize, Deserialize, Clone, Default)]
pub(super) struct Res {
    /// Its command id in the parent.
    pub id: String,
    pub wid: String,
    /// The worker's turn it reports, by its stable id; for `asks`, its request's id.
    pub turn: String,
    /// finished | failed | limit | stopped | asks (a request for the parent, `asks`)
    pub how: String,
    pub text: String,
    pub at: u64,
    /// written | sent (logged in the parent) | delivered | uncertain | held (stopped, till a turn
    /// of the parent's ends or its next message; `ended` by the user, till that message [D330]) |
    /// taken (by the parent's own `wait` or its next message) | dropped (its family is deleted) |
    /// review (a reviewer the switch started: its findings go to its worker instead [D3026])
    pub state: String,
    #[serde(default)]
    pub ended: bool,
    /// The hop of the turn it reports, so a parent it wakes carries the chain on [D2034].
    #[serde(default)]
    pub hop: u64,
    /// `merged=<base>` or `unmerged=<base>` for a worker with commits of its own; else empty.
    #[serde(default)]
    pub merge: String,
}

/// Parents with a result not yet settled; filled from disk at the daemon's first pass.
static OPEN: Mutex<Option<BTreeSet<String>>> = Mutex::new(None);
/// Each worker's `finished` time last looked at, so a pass folds only one that changed.
static SEEN: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);
/// Parents a delivery runs for now.
static SENDING: Mutex<Option<BTreeSet<String>>> = Mutex::new(None);

pub(super) fn dir_of(data: &Path, pid: &str) -> PathBuf {
    core::session_dir(data, pid).join("results")
}

pub(super) fn path_of(data: &Path, pid: &str, wid: &str, turn: &str) -> PathBuf {
    dir_of(data, pid).join(format!("{wid}.{turn}.json"))
}

pub(super) fn all(data: &Path, pid: &str) -> Vec<(PathBuf, Res)> {
    let mut all: Vec<(PathBuf, Res)> = (fs::read_dir(dir_of(data, pid)).into_iter().flatten())
        .flatten()
        .filter_map(|e| read_json(&e.path()).map(|r| (e.path(), r)))
        .collect();
    all.sort_by_key(|(_, r)| r.at);
    all
}

/// Parents with results on disk, read once at the daemon's first use.
fn known(data: &Path) -> BTreeSet<String> {
    let ids = core::ids(data).into_iter();
    ids.filter(|id| dir_of(data, id).exists()).collect()
}

pub(super) fn open(data: &Path, pid: &str) {
    let mut open = OPEN.lock().unwrap();
    open.get_or_insert_with(|| known(data)).insert(pid.into());
}

/// After a pass's rows: a worker whose reported turn ended gets its result written. Only a worker
/// whose turns changed is folded.
pub(super) fn written(data: &Path, wid: &str, row: &Value) {
    images::pass(data, wid, row);
    if row["running"] == true {
        return;
    }
    let at = json!([row["finished"], row["state"]]);
    {
        let mut seen = SEEN.lock().unwrap();
        if seen
            .get_or_insert_with(HashMap::new)
            .insert(wid.into(), at.clone())
            == Some(at)
        {
            return;
        }
    }
    let _ = write_ended(data, wid, row["state"] == "interrupted");
}

/// Writes the result of each reported turn of `wid` that ended and has none yet. `cut`: its host
/// died, so a turn it left open ended too, failed.
pub(super) fn write_ended(data: &Path, wid: &str, cut: bool) -> io::Result<()> {
    let Some(mut l) =
        link(data, wid).filter(|l| !(l.session && super::brigade::leading(data, wid)))
    else {
        return Ok(());
    };
    let f = core::fold(&core::session_dir(data, wid), true)?.fold;
    for turn in &reported(&l, &f) {
        let open = f.turns.iter().any(|t| &t.id == turn);
        let ended = f.cids.contains_key(turn) && (!open || cut);
        if !ended || path_of(data, &l.parent, wid, turn).exists() {
            continue;
        }
        let last = f.last.as_ref().filter(|last| last["id"] == turn.as_str());
        // A turn cut for a rebirth, or one its full window refused, goes on in a fresh
        // conversation, whose own end reports instead [D88, D108], unless it ended done first.
        if (f.cut.as_deref() == Some(turn) && !last.is_some_and(|l| l["outcome"] == "done"))
            || last.is_some_and(|l| l["why"] == "context" && core::rebirth::again_last(&f, l))
        {
            continue;
        }
        // shortcut: a later turn already ended after it, so its own end isn't the fold's last;
        // it reads as finished. Upgrade when the fold keeps each turn's end.
        let how = match last.map_or(if open { "cut" } else { "done" }, |l| {
            l["outcome"].as_str().unwrap_or("done")
        }) {
            "done" => "finished",
            "stopped" => "stopped",
            "limited" => "limit",
            _ if last.is_some_and(|l| l["why"] == "context") => "context",
            _ => "failed",
        };
        // A paused one's stopped task reports nothing: Resume's continue does [D3041]. One that
        // ended by itself before the Pause took reports as ever; one a later wake hid, as stopped.
        // A routed worker's limit isn't its end: it moves within its row or holds [D2041, D2028].
        // A reviewer and a fix turn end at their limit [D3026].
        let moves = how == "limit" && !l.ran["label"].is_null() && review::moves(&l);
        if (l.paused && (how == "stopped" || last.is_none())) || moves {
            continue;
        }
        let Some(how) = review::holds(data, &mut l, wid, turn, how, &f) else {
            continue;
        };
        write(data, &l, wid, turn, how, None)?;
    }
    Ok(())
}

/// A start that failed before its worker could run: its result says why.
pub(super) fn failed(data: &Path, pid: &str, r: &Record) {
    let l = Link {
        parent: pid.into(),
        title: r.title.clone(),
        ran: json!({"agent": r.backend, "model": r.model, "effort": r.effort}),
        review: r.review.clone(),
        ..Default::default()
    };
    let error = r.error.as_deref();
    match l.review["of"].is_string() {
        true => review::after(data, &l, &r.wid, &r.cid, "failed", error),
        false => drop(write(data, &l, &r.wid, &r.cid, "failed", error)),
    }
}

/// The daemon's pass: each parent with an open result, between turns, gets its oldest one, off
/// the loop and one at a time.
pub fn deliver(data: &Path, rows: &BTreeMap<String, Value>) {
    let parents: Vec<String> = {
        let mut open = OPEN.lock().unwrap();
        let open = open.get_or_insert_with(|| known(data));
        open.retain(|p| rows.contains_key(p));
        open.iter().cloned().collect()
    };
    for pid in parents {
        let row = &rows[&pid];
        let takes = TAKES.contains(&row["state"].as_str().unwrap_or(""));
        let archived = !matches!(row["archived"], Value::Null | Value::Bool(false));
        if archived || (!takes && row["running"] == true && !has_sent(data, &pid)) {
            continue;
        }
        {
            let mut sending = SENDING.lock().unwrap();
            if !sending
                .get_or_insert_with(BTreeSet::new)
                .insert(pid.clone())
            {
                continue;
            }
        }
        let (data, pid, state) = (data.to_path_buf(), pid.clone(), row["state"].clone());
        let finished = row["finished"].as_u64().unwrap_or(0);
        thread::spawn(move || {
            if let Err(e) = settle(&data, &pid, state.as_str().unwrap_or(""), finished) {
                eprintln!("brigadierd: worker result for {pid}: {e}");
            }
            SENDING.lock().unwrap().as_mut().map(|s| s.remove(&pid));
        });
    }
}

/// Whether a result still has something to say: a worker's ask only while it waits.
pub(super) fn fresh(data: &Path, r: &Res) -> bool {
    r.how != "asks" || super::asks::waits(data, &r.wid, &r.turn)
}

fn has_sent(data: &Path, pid: &str) -> bool {
    all(data, pid).iter().any(|(_, r)| r.state == "sent")
}

/// How an input logged under `id` came out, by the session's fold and state; none while open.
pub(crate) fn settled(f: &fold::Fold, id: &str, state: &str) -> Option<&'static str> {
    let turn = f.turns.iter().find(|t| t.id == id);
    let last = f.last.as_ref().filter(|l| l["id"] == id);
    Some(match (turn, last) {
        (Some(t), _) if t.delivered.is_some() => "delivered",
        // The agent may have taken it or not: shown, never sent again by itself [D54, D82].
        (Some(_), _) if matches!(state, "uncertain" | "undelivered" | "interrupted") => "uncertain",
        (Some(_), _) => return None,
        (None, Some(l)) if l["delivered"] == true => "delivered",
        (None, Some(_)) => "uncertain",
        // shortcut: its turn ended and a later one followed, so the fold no longer holds it;
        // it counts as delivered. Upgrade when the fold keeps each turn's delivery.
        (None, None) => "delivered",
    })
}

/// Moves a parent's results on: a sent one settles by the parent's log, then the oldest written
/// one is sent. A parent with none left open leaves the set.
fn settle(data: &Path, pid: &str, state: &str, finished: u64) -> io::Result<()> {
    let mut results = all(data, pid);
    // A stopped worker's result goes once a turn of the parent's ends after it [D314].
    let due = |r: &Res| r.state == "held" && !r.ended && r.at < finished;
    for (path, r) in results.iter_mut().filter(|(_, r)| due(r)) {
        r.state = "written".into();
        write_json(path, r)?;
    }
    // Only held ones: kept open, not folded, while the parent idles.
    let any = |s: &str| results.iter().any(|(_, r)| r.state == s);
    let held = any("held");
    if held && !any("written") && !any("sent") {
        return Ok(());
    }
    let dir = core::session_dir(data, pid);
    if closing(data, pid) {
        for (path, mut r) in results.into_iter().filter(|(_, r)| r.state == "written") {
            r.state = "dropped".into();
            write_json(&path, &r)?;
        }
        return Ok(());
    }
    let f = core::fold(&dir, true)?.fold;
    for (path, mut r) in results.iter().filter(|(_, r)| r.state == "sent").cloned() {
        let Some(state) = settled(&f, &r.id, state) else {
            continue;
        };
        r.state = state.into();
        write_json(&path, &r)?;
    }
    // A worker's ask answered or gone before it went isn't sent [D131].
    for (path, mut r) in all(data, pid)
        .into_iter()
        .filter(|(_, r)| r.state == "written" && !fresh(data, r))
    {
        r.state = "dropped".into();
        write_json(&path, &r)?;
    }
    let next = all(data, pid)
        .into_iter()
        .find(|(_, r)| r.state == "written");
    let Some((path, mut r)) = next else {
        if !held && !all(data, pid).iter().any(|(_, r)| r.state == "sent") {
            OPEN.lock().unwrap().as_mut().map(|o| o.remove(pid));
        }
        return Ok(());
    };
    if !TAKES.contains(&state) {
        return Ok(());
    }
    // Under the parent's queue lock: the user's queued messages go first, but those that wait
    // for a block this result's worker holds open, which it carries on [D521].
    let (_lock, waiting) = queue::hold(&dir)?;
    // A wait may have taken it since it was read.
    if (waiting && !super::holding(data, pid))
        || read_json::<Res>(&path).is_none_or(|now| now.state != "written")
    {
        return Ok(());
    }
    if core::fold(&dir, true)?.fold.cids.contains_key(&r.id) {
        r.state = "sent".into();
        return write_json(&path, &r);
    }
    let spec = core::load(data, pid)?;
    crate::rewind::settle_held(data, &spec)?;
    owner::ensure(data, &spec)?;
    let ping = owner::call(data, pid, json!({"op": "ping"}))?;
    let Some(len) = ping["len"].as_u64() else {
        return Ok(());
    };
    let f = core::fold(&dir, true)?;
    let live = fold::live(&f.fold, owner::state(data, pid), data, &procs::all());
    let status = fold::status(&f.fold, &live);
    let state = status["state"].as_str().unwrap_or("");
    // A parent the user stopped (or paused) isn't woken: its results go after the next message
    // or Resume [D95].
    if live.owner != Owner::Alive || !TAKES.contains(&state) || fold::resumable(&f.fold, state) {
        return Ok(());
    }
    let child = ping["child"]
        .as_i64()
        .map(|_| ping["spawn"].as_u64().unwrap_or(0));
    let call = |mut req: Value| {
        if req["if_len"].is_null() && matches!(req["op"].as_str(), Some("input" | "spawn")) {
            req["if_len"] = len.into();
        }
        owner::call(data, pid, req)
    };
    let origin = format!("result:{}", said(&r));
    super::make::say_result(&spec, &f.fold, child, &call, &r.id, &origin, &r.text);
    if core::fold(&dir, true)?.fold.cids.contains_key(&r.id) {
        r.state = "sent".into();
        write_json(&path, &r)?;
    }
    Ok(())
}
