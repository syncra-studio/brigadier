//! Workers [D2034, D3000, D3006, D3007]: sessions an agent starts with `brigadier start`, linked to
//! its parent, each in its own worktree off the parent's branch, starting naked: its brief and one
//! fixed line. A start is reserved under its family's lock and made off the caller's turn, so it
//! never blocks; the daemon's pass makes any reservation a restart cut short, under the same id
//! [D54]. Its result is written by Rust when its task ends and goes to the parent once (`result`).
//! The parent's agent merges a worker's branch with plain git; Brigadier has no merge [D3003].

mod family;
mod make;
mod result;
pub use family::{delete, unlanded};
pub use make::start;
pub use result::{deliver, take};

use crate::{arg, owner, queue, settings};
use brigadier_core::{self as core};
use brigadier_frames::procs;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

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
    /// starting | started | failed
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
    /// Its last task's end, as its result said: how, when, its commits, whether it landed.
    #[serde(default)]
    pub last: Value,
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

/// Whether worker `id` is still being made or a task it reports back on hasn't ended, so a
/// `wait` keeps waiting though its row may not show the turn yet.
pub fn busy(data: &Path, id: &str) -> bool {
    let Some(l) = link(data, id) else {
        return false;
    };
    let made = record(data, &l.parent, id).is_some_and(|r| r.state != "starting");
    let Ok(f) = core::fold(&core::session_dir(data, id), true).map(|r| r.fold) else {
        return !made;
    };
    !made
        || (l.report.iter()).any(|t| !f.cids.contains_key(t) || f.turns.iter().any(|x| &x.id == t))
}

/// `brigadier stop <id>` for session `me`'s agent: only its own workers and theirs [D3032].
pub fn stop(data: &Path, me: &str, id: &str) -> Value {
    let Some(r) = below(data, me).into_iter().find(|r| r.wid == id) else {
        return refuse("You can stop only workers you started.");
    };
    if let Err(e) = queue::stop(data, id) {
        return refuse(&e.to_string());
    }
    ended(data, me, &[id.to_string()], "agent");
    let branch = core::worktrees::branch(&core::session_dir(data, id))
        .ok()
        .flatten();
    let kept = branch.map_or(String::new(), |b| {
        format!(" Its branch {b} keeps its commits.")
    });
    json!({"ok": true, "text": format!("Stopped {} ({id}).{kept}", r.title)})
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
        .filter(|r| r.state == "starting" || crate::sessions::working(data, &r.wid, &all))
        .map(|r| r.wid)
        .collect()
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

/// The start and end outcomes in a worker's log, folded [D2038].
fn outcomes(data: &Path, wid: &str) -> Vec<Value> {
    let mut all = vec![];
    let _ = core::read(&core::session_dir(data, wid), |i| {
        if i["kind"] == "note" && i["event"] == "outcome" {
            let mut o = i.clone();
            o.as_object_mut()
                .map(|o| (o.remove("kind"), o.remove("n"), o.remove("f")));
            all.push(o);
        }
    });
    all
}

/// `workers <id> [--json]`: its family below it with each one's outcomes; `workers <id> stop
/// [<wid>…]`: the user's Stop them, every running one when none is named [D3009, D3011].
pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    core::load(data, id)?;
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
        for w in &ids {
            queue::stop(data, w)?;
        }
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
pub fn pass(data: &Path, rows: &std::collections::BTreeMap<String, Value>) {
    family::resume(data);
    for (id, row) in rows {
        for r in records(data, id).iter().filter(|r| r.state == "starting") {
            make::begin(data, id, &r.wid);
        }
        if !row["worker"].is_null() {
            result::written(data, id, row);
        }
    }
    deliver(data, rows);
}

/// A worker's row facts, for its row [D3010, D3012, D3018]: its parent and brief, its state in
/// a word as the old `workerState`, and its receipt. Null for a session that isn't a worker.
pub fn row(dir: &Path, state: &str, resets: Option<u64>) -> Value {
    let Some(l) = read_json::<Link>(&dir.join("worker.json")) else {
        return Value::Null;
    };
    let last = &l.last;
    let (kind, word) = match state {
        "waiting_answer" | "sign_in" => ("needsYou", "Needs you".to_string()),
        "limited" | "out_of_credits" => (
            "limit",
            match resets {
                Some(at) => format!("Limit until {}", clock(at)),
                None => "Limit".into(),
            },
        ),
        "logged" | "starting" | "working" | "silent" | "idle_jobs" | "retrying" | "checking"
        | "uncertain" | "stalled" => ("working", "Working".into()),
        _ => match last["how"].as_str() {
            Some("failed") => ("failed", "Failed".into()),
            Some("stopped") => ("stopped", "Stopped".into()),
            Some(_) if last["landed"] == false => ("doneNotMerged", "Done · not merged".into()),
            Some(_) => ("done", "Done".into()),
            None if state == "failed" || state == "interrupted" => ("failed", "Failed".into()),
            None => ("working", "Starting".into()),
        },
    };
    let ran = &l.ran;
    let model = [&ran["agent"], &ran["model"], &ran["effort"]];
    let model: Vec<&str> = model.iter().filter_map(|v| v.as_str()).collect();
    json!({"parent": l.parent, "root": l.root, "depth": l.depth, "brief": l.brief, "started": l.at,
        "kind": kind, "word": word, "ended": last["at"], "model": model.join(" · "),
        "receipt": format!("Ran on {}", model.join(" · ")), "added": last["added"], "removed": last["removed"]})
}

fn clock(ms: u64) -> String {
    let secs = (ms / 1000) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    format!("{:02}:{:02}", tm.tm_hour, tm.tm_min)
}
