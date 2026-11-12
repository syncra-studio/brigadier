//! A worker's result [D3006]: when a task it reports back on ends, Rust writes how it ended, its
//! last message, its branch and commits, then delivers it into the parent once, on the delivery
//! rules [D54, D82, D237]: written first in the parent's `results/`, sent under its own id with the
//! parent between turns and its queue empty, done once the parent's log proves the agent took it.
//! Logged without that proof, it's uncertain and never sent again by itself. An idle parent wakes;
//! a busy one gets it after its turn. Turns the user starts in a worker report nothing.

use super::{Link, Record, closing, git, link, read_json, write_json};
use crate::{owner, queue};
use brigadier_core::fold::{self, Owner};
use brigadier_core::{self as core};
use brigadier_frames::{log, procs};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;

/// The most of its last message a result carries [D3006].
const LAST: usize = 16 << 10;

/// The states a parent takes a result in: between turns, as the queue's.
const TAKES: [&str; 4] = ["idle", "idle_jobs", "stopped", "failed"];

#[derive(Serialize, Deserialize, Clone, Default)]
struct Res {
    /// Its command id in the parent.
    id: String,
    wid: String,
    /// The worker's turn it reports, by its stable id.
    turn: String,
    /// finished | failed | limit | stopped
    how: String,
    text: String,
    at: u64,
    /// written | sent (logged in the parent) | delivered | uncertain | held (stopped, not sent,
    /// proposed) | taken (by the parent's own `wait`) | dropped (its family is being deleted)
    state: String,
    /// The hop of the turn it reports, so a parent it wakes carries the chain on [D2034].
    #[serde(default)]
    hop: u64,
}

/// Parents with a result not yet settled; filled from disk at the daemon's first pass.
static OPEN: Mutex<Option<BTreeSet<String>>> = Mutex::new(None);
/// Each worker's `finished` time last looked at, so a pass folds only one that changed.
static SEEN: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);
/// Parents a delivery runs for now.
static SENDING: Mutex<Option<BTreeSet<String>>> = Mutex::new(None);

fn dir_of(data: &Path, pid: &str) -> PathBuf {
    core::session_dir(data, pid).join("results")
}

fn path_of(data: &Path, pid: &str, wid: &str, turn: &str) -> PathBuf {
    dir_of(data, pid).join(format!("{wid}.{turn}.json"))
}

fn all(data: &Path, pid: &str) -> Vec<(PathBuf, Res)> {
    let mut all: Vec<(PathBuf, Res)> = (fs::read_dir(dir_of(data, pid)).into_iter().flatten())
        .flatten()
        .filter_map(|e| read_json(&e.path()).map(|r| (e.path(), r)))
        .collect();
    all.sort_by_key(|(_, r)| r.at);
    all
}

fn open(pid: &str) {
    let mut open = OPEN.lock().unwrap();
    open.get_or_insert_with(BTreeSet::new).insert(pid.into());
}

/// After a pass's rows: a worker whose reported turn ended gets its result written. Only a worker
/// whose turns changed is folded.
pub(super) fn written(data: &Path, wid: &str, row: &Value) {
    if row["running"] == true {
        return;
    }
    let at = row["finished"].clone();
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
    let _ = write_ended(data, wid);
}

/// Writes the result of each reported turn of `wid` that ended and has none yet.
fn write_ended(data: &Path, wid: &str) -> io::Result<()> {
    let Some(l) = link(data, wid) else {
        return Ok(());
    };
    let f = core::fold(&core::session_dir(data, wid), true)?.fold;
    for turn in &l.report {
        let ended = f.cids.contains_key(turn) && !f.turns.iter().any(|t| &t.id == turn);
        if !ended || path_of(data, &l.parent, wid, turn).exists() {
            continue;
        }
        let last = f.last.as_ref().filter(|last| last["id"] == turn.as_str());
        // shortcut: a later turn already ended after it, so its own end isn't the fold's last;
        // it reads as finished. Upgrade when the fold keeps each turn's end.
        let how = match last.map_or("done", |l| l["outcome"].as_str().unwrap_or("done")) {
            "done" => "finished",
            "stopped" => "stopped",
            "limited" => "limit",
            _ => "failed",
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
        ..Default::default()
    };
    let _ = write(data, &l, &r.wid, &r.cid, "failed", r.error.as_deref());
}

fn git_lines(dir: &str, args: &[&str], most: usize) -> Vec<String> {
    let out = git(dir, args).unwrap_or_default();
    let lines: Vec<String> = out.lines().map(String::from).collect();
    let more = lines.len().saturating_sub(most);
    let mut shown: Vec<String> = lines.into_iter().take(most).collect();
    if more > 0 {
        shown.push(format!("… {more} more"));
    }
    shown
}

/// Writes one result: the sender's record, first, in the parent's folder [D54]. Then the worker's
/// row shows how it ended. `error`: a start that failed, whose worker never ran.
fn write(
    data: &Path,
    l: &Link,
    wid: &str,
    turn: &str,
    how: &str,
    error: Option<&str>,
) -> io::Result<()> {
    let dir = core::session_dir(data, wid);
    let spec = core::load(data, wid).ok();
    let cwd = spec.as_ref().map_or(String::new(), |s| s.cwd.clone());
    let branch = core::worktrees::branch(&dir).ok().flatten();
    let base = core::worktrees::base(&dir);
    let word = match how {
        "finished" => "finished",
        "stopped" => "was stopped",
        "limit" => "stopped at a usage limit",
        _ => "failed",
    };
    let mut text = format!("Worker {} ({wid}) {word}.\n", l.title);
    if let Some(e) = error {
        text += &format!("It didn't start: {e}\n");
    }
    let (mut added, mut removed, mut commits) = (0u64, 0u64, 0usize);
    if let (Some(branch), Some(base)) = (&branch, &base) {
        let range = format!("{base}..HEAD");
        let log = git_lines(&cwd, &["log", "--oneline", &range], 20);
        commits = git(&cwd, &["rev-list", "--count", &range]).map_or(0, |n| n.parse().unwrap_or(0));
        text += &format!("Its branch {branch}, from {base}: {commits} commits not in {base}\n");
        for line in &log {
            text += &format!("  {line}\n");
        }
        let stat =
            git(&cwd, &["diff", "--shortstat", &format!("{base}...HEAD")]).unwrap_or_default();
        if !stat.trim().is_empty() {
            text += &format!("{}\n", stat.trim());
        }
        let num = git(&cwd, &["diff", "--numstat", &format!("{base}...HEAD")]).unwrap_or_default();
        for line in num.lines() {
            let mut n = line
                .split_whitespace()
                .map(|x| x.parse::<u64>().unwrap_or(0));
            added += n.next().unwrap_or(0);
            removed += n.next().unwrap_or(0);
        }
        let dirty = git_lines(&cwd, &["status", "--porcelain"], 20);
        if !dirty.is_empty() {
            text += "Uncommitted:\n";
            for line in &dirty {
                text += &format!("  {line}\n");
            }
        }
    }
    let ran = &l.ran;
    let ran: Vec<&str> = [&ran["agent"], &ran["model"], &ran["effort"]]
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    text += &format!("Ran on {}.\n", ran.join(" · "));
    // That turn's own last message, not a later turn's the user started in the worker [D3006].
    if let Some(mut last) = last_of_turn(data, wid, turn) {
        if last.len() > LAST {
            let mut at = LAST;
            while !last.is_char_boundary(at) {
                at -= 1;
            }
            last.truncate(at);
            last += "\n[cut at 16 KB]";
        }
        text += &format!("Its last message:\n{}\n", last.trim_end());
    }
    text +=
        &format!("\n`brigadier read {wid}` for more. Merge its branch with git once it's right.");
    let landed = core::worktrees::unlanded(&dir).ok().flatten().is_none();
    let res = Res {
        id: format!("r{}", core::adapters::uuid()[..13].replace('-', "")),
        wid: wid.into(),
        turn: turn.into(),
        how: how.into(),
        text,
        at: log::now_ms(),
        // Proposed: a stopped task's result is kept, never sent: its parent or the user stopped
        // it on purpose, and it would wake a parent the user just stopped [O3000].
        state: if how == "stopped" { "held" } else { "written" }.into(),
        hop: crate::peers::hop_of(data, wid, turn),
    };
    fs::create_dir_all(dir_of(data, &l.parent))?;
    write_json(&path_of(data, &l.parent, wid, turn), &res)?;
    open(&l.parent);
    let link_path = dir.join("worker.json");
    if let Some(mut l) = read_json::<Link>(&link_path) {
        l.last = json!({"how": how, "at": res.at, "landed": landed,
            "commits": commits, "added": added, "removed": removed});
        write_json(&link_path, &l)?;
        if spec.is_some() {
            let end = json!({"event": "outcome", "phase": "end", "how": how, "commits": commits, "at": res.at});
            let _ = owner::call(data, wid, json!({"op": "note", "data": end}));
        }
    }
    Ok(())
}

/// A turn's own last message, by the turn's stable id.
pub(crate) fn last_of_turn(data: &Path, id: &str, turn: &str) -> Option<String> {
    let mut thread = core::thread::Thread::default();
    let _ = core::rewind::read_active(&core::session_dir(data, id), |i| thread.push(i));
    let items = thread.session(id, "", None, None)["items"].take();
    (items.as_array().into_iter().flatten().rev())
        .find(|i| i["kind"] == "message" && i["role"] == "assistant" && i["turnId"] == turn)
        .and_then(|i| i["text"].as_str().map(String::from))
}

/// The hop a result carries, by its command id in the parent.
pub(crate) fn hop(data: &Path, pid: &str, id: &str) -> Option<u64> {
    all(data, pid)
        .into_iter()
        .find(|(_, r)| r.id == id)
        .map(|(_, r)| r.hop)
}

/// The parent's own `wait` on its worker takes the result it returns, so it isn't sent again; any
/// other session's wait never does [D3034]. Its text, when there's one to take.
/// `turn` names the exact report turn waited on (a `send --wait`); none takes its latest. Taken
/// under the parent's queue lock, which a delivery holds while it sends [D3006, D3034].
pub fn take(data: &Path, me: &str, wid: &str, turn: Option<&str>) -> Option<String> {
    let l = link(data, wid).filter(|l| l.parent == me)?;
    let _ = write_ended(data, wid);
    let (_lock, _) = queue::hold(&core::session_dir(data, me)).ok()?;
    let (path, mut res) = all(data, &l.parent)
        .into_iter()
        .rev()
        .find(|(_, r)| r.wid == wid && r.state == "written" && turn.is_none_or(|t| r.turn == t))?;
    res.state = "taken".into();
    write_json(&path, &res).ok()?;
    Some(res.text)
}

/// The daemon's pass: each parent with an open result, between turns, gets its oldest one, off
/// the loop and one at a time.
pub fn deliver(data: &Path, rows: &BTreeMap<String, Value>) {
    let parents: Vec<String> = {
        let mut open = OPEN.lock().unwrap();
        let open = open.get_or_insert_with(|| {
            let ids = core::ids(data).into_iter();
            ids.filter(|id| dir_of(data, id).exists()).collect()
        });
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
        thread::spawn(move || {
            if let Err(e) = settle(&data, &pid, state.as_str().unwrap_or("")) {
                eprintln!("brigadierd: worker result for {pid}: {e}");
            }
            SENDING.lock().unwrap().as_mut().map(|s| s.remove(&pid));
        });
    }
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
fn settle(data: &Path, pid: &str, state: &str) -> io::Result<()> {
    let results = all(data, pid);
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
    let next = all(data, pid)
        .into_iter()
        .find(|(_, r)| r.state == "written");
    let Some((path, mut r)) = next else {
        if !all(data, pid).iter().any(|(_, r)| r.state == "sent") {
            OPEN.lock().unwrap().as_mut().map(|o| o.remove(pid));
        }
        return Ok(());
    };
    if !TAKES.contains(&state) {
        return Ok(());
    }
    // Under the parent's queue lock: the user's queued messages go first.
    let (_lock, waiting) = queue::hold(&dir)?;
    // A wait may have taken it since it was read.
    if waiting || read_json::<Res>(&path).is_none_or(|now| now.state != "written") {
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
    if live.owner != Owner::Alive || !TAKES.contains(&status["state"].as_str().unwrap_or("")) {
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
    let origin = format!("result:{}:{}", r.how, r.wid);
    super::make::say_result(&spec, &f.fold, child, &call, &r.id, &origin, &r.text);
    if core::fold(&dir, true)?.fold.cids.contains_key(&r.id) {
        r.state = "sent".into();
        write_json(&path, &r)?;
    }
    Ok(())
}
