//! Workers [D2034, D3000, D3006, D3007]: sessions an agent starts with `brigadier start`, linked to
//! its parent, each in its own worktree off the parent's branch, starting naked: its brief and one
//! fixed line. A start is reserved under its family's lock and made off the caller's turn, so it
//! never blocks; the daemon's pass makes any reservation a restart cut short, under the same id
//! [D54]. Its result is written by Rust when its task ends and goes to the parent once (`result`).
//! The parent's agent merges a worker's branch with plain git; Brigadier has no merge [D3003].

mod asks;
mod busy;
mod family;
mod make;
mod pause;
mod result;
mod review;
pub(crate) mod row;
pub use asks::{answer, asks_parent, for_user};
pub(crate) use asks::{built_goes, question, told_held, unbuilt};
pub(crate) use busy::at_work;
use busy::busy_in;
pub use busy::{busy, owes};
pub use family::delete;
pub use make::start;
pub(crate) use make::{begin, full, land_line};
pub use pause::held;
pub use result::{deliver, take, take_ask, told_take, went_with, with_next};
pub(crate) use result::{hop as result_hop, settled, take_shell, told_notice, told_shell, unrun};
pub(crate) use review::{at, last_of_turn, moves};
pub use row::{holding, holds, row};

use crate::{arg, owner, queue, settings};
use brigadier_core as core;
use brigadier_frames::{log, procs};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// A worker's reservation, in its parent's `workers/` folder: all its making needs, so a restart
/// makes the same worker under the same id and never a second one [D54].
#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct Record {
    pub wid: String,
    /// The brief's command id: its first turn's stable id.
    pub cid: String,
    pub title: String,
    pub brief: String,
    pub at: u64,
    pub depth: u64,
    pub root: String,
    /// starting | started | failed | stopped (before its brief went)
    pub state: String,
    #[serde(default)]
    pub error: Option<String>,
    pub asked: Value,
    pub backend: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub level: Option<String>,
    pub account: Option<String>,
    pub project: Option<String>,
    /// The parent's branch it starts from; none for a chat with no project.
    pub base: Option<String>,
    /// What its `ran` keeps beside agent, model, effort and account: its routing row, the
    /// account's name and quota at the start, the same-row note [D2037, D2041, D3018].
    #[serde(default)]
    pub pick: Value,
    /// Its row out of quota: the user's call it waits for before it starts [D2028, D342].
    #[serde(default)]
    pub hold: Value,
    /// A retry's `retry_of`, `chain`, `step` and `note`, for its start outcome [D2037].
    #[serde(default)]
    pub retry: Value,
    /// A reviewer's mark, as its link's (`review.rs`) [D3026].
    #[serde(default)]
    pub review: Value,
    #[serde(default)]
    pub waits: bool,
}

/// `worker.json` in the worker's own folder: who started it, and which of its turns report back.
#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct Link {
    pub parent: String,
    pub root: String,
    pub depth: u64,
    pub title: String,
    pub brief: String,
    pub at: u64,
    /// The turns whose end goes back to the parent, by their stable id: today its brief's [D3006].
    pub report: Vec<String>,
    pub ran: Value,
    /// What its parent's agent asked for: row, agent, model, effort, as given [D2037].
    #[serde(default)]
    pub asked: Value,
    /// Its last task's end, as its result said: how, when, its commits, whether it landed.
    #[serde(default)]
    pub last: Value,
    /// The user paused it: its queue holds, and it reports nothing until Resume [D3041].
    #[serde(default)]
    pub paused: bool,
    /// A reviewer's mark, or a reviewed worker's review (`review.rs`) [D3026].
    #[serde(default)]
    pub review: Value,
}

fn records_dir(data: &Path, pid: &str) -> PathBuf {
    core::session_dir(data, pid).join("workers")
}

pub(crate) fn read_json<T: for<'a> Deserialize<'a>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

pub(crate) fn write_json(path: &Path, v: &impl Serialize) -> io::Result<()> {
    core::write_atomic(path, &serde_json::to_vec_pretty(v)?)
}

pub(crate) fn link(data: &Path, id: &str) -> Option<Link> {
    read_json(&core::session_dir(data, id).join("worker.json"))
}

pub(crate) fn record(data: &Path, pid: &str, wid: &str) -> Option<Record> {
    read_json(&records_dir(data, pid).join(format!("{wid}.json")))
}

pub(crate) fn save(data: &Path, pid: &str, r: &Record) -> io::Result<()> {
    let dir = records_dir(data, pid);
    fs::create_dir_all(&dir)?;
    write_json(&dir.join(format!("{}.json", r.wid)), r)
}

/// A session's own workers, oldest first.
pub(crate) fn records(data: &Path, pid: &str) -> Vec<Record> {
    let mut all: Vec<Record> = (fs::read_dir(records_dir(data, pid)).into_iter().flatten())
        .flatten()
        .filter_map(|e| read_json(&e.path()))
        .collect();
    all.sort_by_key(|r| r.at);
    all
}

/// Every worker below a session, its own first, then theirs.
pub(crate) fn below(data: &Path, id: &str) -> Vec<Record> {
    let mine = records(data, id);
    let deeper: Vec<Record> = mine.iter().flat_map(|r| below(data, &r.wid)).collect();
    mine.into_iter().chain(deeper).collect()
}

/// The session the user started that `id` works under, and how deep `id` is (theirs is 0).
pub(crate) fn place(data: &Path, id: &str) -> (String, u64) {
    link(data, id).map_or_else(|| (id.to_string(), 0), |l| (l.root, l.depth))
}

/// Held while a family's count is read and a start reserved, so parallel starts can't pass the
/// limit; and while its delete is recorded.
pub(crate) fn family_lock(data: &Path, root: &str) -> io::Result<fs::File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(core::session_dir(data, root).join("family.lock"))?;
    file.lock()?;
    Ok(file)
}

pub(crate) const CLOSING: &str = "family-delete.json";

/// Whether `id` or a session above it is having its family deleted: no start or result goes in.
pub(crate) fn closing(data: &Path, id: &str) -> bool {
    let mut at = Some(id.to_string());
    while let Some(id) = at {
        if core::session_dir(data, &id).join(CLOSING).exists() {
            return true;
        }
        at = link(data, &id).map(|l| l.parent);
    }
    false
}

pub(crate) fn git(dir: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

pub(crate) fn refuse(message: &str) -> Value {
    json!({"ok": false, "error": message})
}

pub(crate) fn setting(data: &Path, key: &str, default: u64) -> u64 {
    settings::get(data, key).parse().unwrap_or(default)
}

/// Whether parent `pid`'s worker `wid` ended with nothing left to wake it for: not being made, not
/// paused, each task it reports ended with its result written, and none still on its way. A
/// stopped one's result, held for the parent's next turn, wakes no one [D314].
pub fn over(data: &Path, pid: &str, wid: &str) -> bool {
    over_but(data, pid, wid, "")
}

/// The same, but for its result `but`, which is on its way now.
fn over_but(data: &Path, pid: &str, wid: &str, but: &str) -> bool {
    let Some(l) = link(data, wid) else {
        return record(data, pid, wid).is_none_or(|r| r.state != "starting");
    };
    let due = |r: &result::Res| {
        r.wid == wid && r.id != but && matches!(r.state.as_str(), "written" | "sent")
    };
    !l.paused
        && !owes(data, wid)
        && result::told(data, pid, wid, &l)
        && !result::all(data, pid).iter().any(|(_, r)| due(r))
}

/// What session `me`'s `wait` is on: the session it names, else its own workers still working or
/// with a result it hasn't taken, as the old app's bare wait.
pub fn waited(data: &Path, me: &str, id: &str) -> Result<Vec<String>, Value> {
    if !id.is_empty() {
        return Ok(vec![id.into()]);
    }
    let results = result::all(data, me);
    let pending = |w: &str| {
        (results.iter()).any(|(_, r)| r.wid == w && r.state == "written" && result::fresh(data, r))
    };
    let ids: Vec<String> = (records(data, me).into_iter().map(|r| r.wid))
        .filter(|w| owes(data, w) || pending(w))
        .collect();
    match ids.is_empty() {
        true => Err(refuse(
            "You have no workers working. `brigadier wait <id>` waits on a session.",
        )),
        false => Ok(ids),
    }
}

/// `brigadier stop <id>` for session `me`'s agent: only its own workers and theirs [D3032].
pub fn stop(data: &Path, me: &str, id: &str) -> Value {
    let Some(r) = below(data, me).into_iter().find(|r| r.wid == id) else {
        return refuse("You can stop only workers you started.");
    };
    if let Err(e) = end(data, me, id, "agent") {
        return refuse(&e.to_string());
    }
    ended(data, me, &[id.to_string()], "agent");
    let dir = core::session_dir(data, id);
    let branch = core::worktrees::branch(&dir).ok().flatten();
    // Only a branch past where it began has commits to keep.
    let made = || {
        let start = core::worktrees::lands(&dir).ok()??.base_commit;
        let cwd = core::load(data, id).ok()?.cwd;
        git(&cwd, &["rev-list", "--count", &format!("{start}..HEAD")])
    };
    let kept = branch
        .filter(|_| made().is_some_and(|n| n != "0"))
        .map_or(String::new(), |b| {
            format!(" Its branch {b} keeps its commits.")
        });
    json!({"ok": true, "text": format!("Stopped {} ({id}).{kept}", r.title)})
}

/// Stops worker `wid` below `top`. One being made, or held on its card (by Stop, not Pause), is
/// marked so its brief never goes, then stopped once made; its card goes. `by`: "user"/"pause".
fn halt(data: &Path, top: &str, wid: &str, by: &str) -> io::Result<()> {
    if let Some(pid) = parent_of(data, top, wid) {
        let _family = family_lock(data, &place(data, &pid).0)?;
        if let Some(mut r) = record(data, &pid, wid).filter(|r| crate::routing::stops(r, by)) {
            r.state = "stopped".into();
            save(data, &pid, &r)?;
        }
        // Its card settled under the lock, so a redraw of it can't come between the read and this.
        crate::routing::stopped(data, wid, by);
    } else {
        crate::routing::stopped(data, wid, by);
    }
    let started = Instant::now();
    while make::making(&[wid.to_string()]) && started.elapsed().as_secs() < 30 {
        std::thread::sleep(Duration::from_millis(100));
    }
    if core::session_dir(data, wid).join("session.json").exists()
        && queue::stop(data, wid, by)?["ok"] == false
    {
        return Err(io::Error::other("Couldn't stop the worker"));
    }
    Ok(())
}

/// End: `halt`, and a paused one is no longer paused but stopped; what it held stays held. Its
/// own workers on hand end with it, its thread saying so; `by` names who ended them.
fn end(data: &Path, top: &str, wid: &str, by: &str) -> io::Result<()> {
    let all = procs::all();
    // Marked ended before its stop, so nothing sent to it meanwhile goes in [D96]; a finished
    // one keeps how it finished. Its stopped turn's result, if it has one, says more.
    if let Some(mut l) =
        link(data, wid).filter(|l| l.paused || l.last.is_null() || at_work(data, wid, &all))
    {
        l.paused = false;
        // Who ended it, for its result: one the user ended goes quietly [D330].
        l.last = json!({"how": "stopped", "at": brigadier_frames::log::now_ms(), "by": by});
        write_json(&core::session_dir(data, wid).join("worker.json"), &l)?;
    }
    halt(data, top, wid, "user")?;
    review::stop(data, top, wid);
    let mine: Vec<String> = (records(data, wid).into_iter())
        .filter(|r| {
            r.state == "starting"
                || at_work(data, &r.wid, &all)
                || link(data, &r.wid).is_some_and(|l| l.paused)
        })
        .map(|r| r.wid)
        .collect();
    for w in &mine {
        end(data, top, w, by)?;
    }
    if !mine.is_empty() {
        ended(data, wid, &mine, by);
    }
    Ok(())
}

/// Which session below `top` (or `top` itself) started `wid`.
fn parent_of(data: &Path, top: &str, wid: &str) -> Option<String> {
    let mine = records(data, top);
    if mine.iter().any(|r| r.wid == wid) {
        return Some(top.into());
    }
    mine.iter().find_map(|r| parent_of(data, &r.wid, wid))
}

fn note(data: &Path, id: &str, note: Value) {
    let _ = owner::call(data, id, json!({"op": "note", "data": note}));
}

fn ended(data: &Path, pid: &str, ids: &[String], by: &str) {
    note(
        data,
        pid,
        json!({"event": "worker", "phase": "ended", "ids": ids, "by": by}),
    );
}

/// The workers below `id` whose task runs now.
fn working(data: &Path, id: &str) -> Vec<String> {
    let all = procs::all();
    (below(data, id).into_iter())
        .filter(|r| r.state == "starting" || at_work(data, &r.wid, &all))
        .map(|r| r.wid)
        .collect()
}

/// The user is back mid-night: every worker still at it ends with its session's turn.
pub(crate) fn end_all(data: &Path, id: &str) -> io::Result<()> {
    let now = working(data, id);
    let mine: Vec<String> = (records(data, id).into_iter().map(|r| r.wid))
        .filter(|w| now.contains(w) || below(data, w).iter().any(|r| now.contains(&r.wid)))
        .collect();
    for w in &mine {
        end(data, id, w, "user")?;
    }
    if !mine.is_empty() {
        ended(data, id, &mine, "user");
    }
    Ok(())
}

/// After the user's Stop on a session: its turn alone ended, so the thread says which of its
/// workers still run, one click from stopping too [D3009, D3011].
pub fn still(data: &Path, id: &str) {
    let ids = working(data, id);
    if !ids.is_empty() {
        note(
            data,
            id,
            json!({"event": "worker", "phase": "still", "ids": ids}),
        );
    }
}

/// What ended a worker's last task where it didn't finish: "infrastructure", "environment",
/// "quota", "user", "refused" or "unknown"; "" where it did. One written before causes were kept: a failure
/// its log has no end of was its host dying.
pub(crate) fn cause<'a>(l: &'a Link, notes: &[Value]) -> &'a str {
    if let Some(c) = l.last["cause"].as_str() {
        return c;
    }
    let end = notes.iter().rev().find(|n| n["phase"] == "end");
    match l.last["how"].as_str() {
        Some("failed") if end.is_none_or(|e| e["how"] != "failed" || e["temporary"] == true) => {
            "infrastructure"
        }
        Some("failed" | "context") => "unknown",
        Some("limit") => "quota",
        Some("stopped") => "user",
        _ => "",
    }
}

/// The start and end outcomes in a worker's log [D2038].
pub(crate) fn outcomes(data: &Path, wid: &str) -> Vec<Value> {
    let f = core::fold(&core::session_dir(data, wid), true);
    let mut all = f.map(|f| f.fold.outcomes).unwrap_or_default();
    for o in &mut all {
        o.as_object_mut()
            .map(|o| (o.remove("kind"), o.remove("n"), o.remove("f")));
    }
    all
}

/// `workers <id> [--json]`: its family below it with each one's outcomes; `workers <id> stop
/// [<wid>…]`: the user's Stop them, every running one when none is named [D3009, D3011];
/// `workers <id> pause|resume <wid>`: the user's Pause and Resume [D3041].
pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    core::load(data, id)?;
    if let Some(how @ ("pause" | "resume")) = args.get(2).map(String::as_str) {
        let reply = pause::run(data, id, how, arg(args, 3)?);
        return match reply["error"].as_str() {
            Some(e) => Err(io::Error::other(e.to_string())),
            None => Ok(reply),
        };
    }
    if args.get(2).is_some_and(|a| a == "stop") {
        let mine: HashSet<String> = below(data, id).into_iter().map(|r| r.wid).collect();
        let named: Vec<String> = args[3..].to_vec();
        let ids = if named.is_empty() {
            working(data, id)
        } else {
            named
        };
        if let Some(other) = ids.iter().find(|w| !mine.contains(*w)) {
            return Err(io::Error::other(format!("{other} isn't a worker of {id}")));
        }
        std::thread::scope(|scope| {
            let stops: Vec<_> = ids
                .iter()
                .map(|w| scope.spawn(move || end(data, id, w, "user")))
                .collect();
            let results: Vec<_> = stops
                .into_iter()
                .map(|stop| {
                    stop.join()
                        .unwrap_or_else(|_| Err(io::Error::other("Couldn't stop a worker")))
                })
                .collect();
            results.into_iter().collect::<io::Result<()>>()
        })?;
        if !ids.is_empty() {
            ended(data, id, &ids, "user");
        }
        return Ok(json!({"ok": true, "ended": ids}));
    }
    let list: Vec<Value> = (below(data, id).into_iter())
        .map(|r| {
            let parent = link(data, &r.wid).map(|l| l.parent);
            json!({"id": r.wid, "title": r.title, "parent": parent, "depth": r.depth, "state": r.state,
                "error": r.error, "outcomes": outcomes(data, &r.wid)})
        })
        .collect();
    Ok(json!({"ok": true, "workers": list}))
}

/// The daemon's pass: makes what a restart left reserved, then writes and delivers results.
/// `looked`: the sessions whose rows the index worked out now, all of them in its full passes.
pub fn pass(data: &Path, rows: &BTreeMap<String, Value>, looked: &BTreeSet<String>) {
    family::resume(data);
    for (id, row) in rows.iter().filter(|(id, _)| looked.contains(*id)) {
        for r in records(data, id).iter().filter(|r| r.state == "starting") {
            make::begin(data, id, &r.wid);
        }
        crate::agent::new::resume(data, id);
        if !row["worker"].is_null() {
            result::written(data, id, row);
            crate::relay::mockup::retry(data, id);
            crate::sessions::freed::pass(data, id, row);
        }
        asks::pass(data, id, row);
        if row["worker"]["kind"] == "doneNotMerged" {
            row::merged(data, id);
        }
        // A hold the user said to wait out goes on as picked once its reset has passed [D2028].
        if (row["worker"]["due"].as_u64()).is_some_and(|at| at <= log::now_ms())
            && matches!(
                row["state"].as_str(),
                Some("new" | "idle" | "limited" | "out_of_credits")
            )
        {
            crate::routing::due(data, id);
        }
    }
    deliver(data, rows);
}
