//! Going back to one of the user's own messages [D378, D384]: the conversation is cut at that
//! turn through its agent's own support, and on request the folder goes back too, from Brigadier's
//! own snapshots. Each phase is written down first, so one cut short finishes or rolls back on
//! proof before anything else runs [D54, D300].

mod active;
mod plan;
mod snap;

use crate::adapters::{self, Cut, Failed, Landing, Rewound};
use crate::fold::{Boundary, Fold, Live, Owner};
use crate::{Call, Spec, as_run, session, session_dir, worktrees, write_atomic};
pub use active::{Active, read_active};
use brigadier_frames::log::now_ms;
use plan::{Files, plan};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use snap::{Record, Shot, Store};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

const OP: &str = "rewind.json";
/// How long after a turn ends its folder still counts as its result (proposed): covers the daemon's
/// pass and a queued message going at once, and is too short for an edit by hand and a send.
pub const GRACE_MS: u64 = 2_000;
const STOP_WAIT: Duration = Duration::from_secs(5);

/// The operation under way, rewritten at each phase.
#[derive(Serialize, Deserialize)]
struct Op {
    phase: String,
    op: String,
    cid: String,
    backend: String,
    resume: String,
    at: u64,
    kept: Option<Boundary>,
    dropped: Boundary,
    /// The folder just before the rewind, the paths it changes, and where they go.
    pre: Option<Shot>,
    target: Option<String>,
    paths: BTreeSet<String>,
    hand: Vec<String>,
    left_out: Vec<String>,
    commits: bool,
    done: Option<Rewound>,
}

fn refused(error: &str, message: impl Into<String>) -> Value {
    json!({"ok": false, "error": error, "message": message.into()})
}

/// Takes the folder as a new turn starts, once the last one's end is settled. Called only where
/// no turn is open; a snapshot that fails leaves that turn keep-only and the message still goes.
pub fn before(spec: &Spec, f: &Fold, cid: &str) {
    if !f.turns.is_empty() {
        return;
    }
    let Some(store) = Store::of(spec) else { return };
    ended(&store, f);
    if store.load(cid).is_none()
        && let Ok(before) = store.capture()
    {
        let _ = store.save(cid, &Record { before, end: None });
    }
}

/// Takes the folder as the last turn ended. Too late, the edits may be the user's, not the agent's,
/// and it stays missing: that range offers keep only.
pub fn ends(spec: &Spec, f: &Fold) {
    if let Some(store) = Store::of(spec) {
        ended(&store, f);
    }
}

fn ended(store: &Store, f: &Fold) {
    let Some(last) = f.last.as_ref().filter(|_| f.turns.is_empty()) else {
        return;
    };
    let (Some(id), Some(ts)) = (last["id"].as_str(), last["ts"].as_u64()) else {
        return;
    };
    let Some(mut record) = store.load(id).filter(|r| r.end.is_none()) else {
        return;
    };
    if now_ms().saturating_sub(ts) <= GRACE_MS
        && let Ok(end) = store.capture()
    {
        record.end = Some(end);
        let _ = store.save(id, &record);
    }
}

fn local(data: &Path, spec: &Spec) -> bool {
    Path::new(&spec.cwd) != worktrees::path(data, &spec.id)
}

/// Serialises a restore against turns starting in a folder other sessions may use.
pub(crate) fn checkout_lock(data: &Path, exclusive: bool) -> io::Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data.join("checkout.lock"))?;
    if exclusive {
        file.lock()?
    } else {
        file.lock_shared()?
    }
    Ok(file)
}

/// Whether another session that isn't archived works in the same folder.
fn shared(data: &Path, spec: &Spec) -> bool {
    let mine = fs::canonicalize(&spec.cwd).ok();
    (crate::ids(data).iter())
        .filter(|id| **id != spec.id)
        .filter_map(|id| crate::load(data, id).ok())
        .filter(|other| !other.dir.join("archived").exists())
        .any(|other| fs::canonicalize(&other.cwd).ok() == mine)
}

/// The store and each turn's edges, or why the folder can't go back. No git, so it's quick.
fn ready(
    data: &Path,
    spec: &Spec,
    f: &Fold,
    cid: &str,
) -> Result<(Store, plan::Edges), &'static str> {
    let store = Store::of(spec).ok_or("no_project")?;
    if local(data, spec) && shared(data, spec) {
        return Err("shared");
    }
    let (_, turns) = f.range(cid).ok_or("missing")?;
    let shots = plan::shots(&store, &turns)?;
    Ok((store, shots))
}

fn plan_for(data: &Path, spec: &Spec, f: &Fold, cid: &str) -> Result<Files, &'static str> {
    let (store, shots) = ready(data, spec, f, cid)?;
    plan(&store, shots)
}

/// What the confirmation shows: whether the folder can go back, quick enough to be there as the
/// dialog opens; with `files`, what a restore would and wouldn't do, from a fresh look at the folder.
pub fn preview(data: &Path, spec: &Spec, f: &Fold, cid: &str, files: bool) -> Value {
    if !f.points().iter().any(|p| p == cid) {
        return refused("gone", "This message can't be rewound to any more.");
    }
    if !files {
        return match ready(data, spec, f, cid) {
            Ok(_) => json!({"ok": true, "restore": true}),
            Err(why) => json!({"ok": true, "restore": false, "why": why}),
        };
    }
    match plan_for(data, spec, f, cid) {
        Ok(p) => json!({"ok": true, "restore": true, "paths": p.paths, "hand": p.hand,
            "leftOut": p.left_out, "commits": p.commits}),
        Err(why) => json!({"ok": true, "restore": false, "why": why}),
    }
}

fn gate(f: &Fold, live: &Live, ping: &Value, cid: &str) -> Result<(), Value> {
    if !(ping["caps"].as_array()).is_some_and(|c| c.iter().any(|c| c == "rewind")) {
        return Err(refused(
            "old_host",
            "This session's host is on an older build. It moves to the new one once nothing runs.",
        ));
    }
    if live.owner != Owner::Alive {
        return Err(refused(
            "no_host",
            "This session isn't reachable right now.",
        ));
    }
    if !f.turns.is_empty() {
        return Err(refused("running", "Stop the turn or let it finish first."));
    }
    if live.jobs > 0 {
        return Err(refused(
            "jobs",
            "Background work from this session is still running. Stop it first.",
        ));
    }
    if !f.points().iter().any(|p| p == cid) {
        return Err(refused(
            "gone",
            "This message can't be rewound to any more.",
        ));
    }
    Ok(())
}

fn ping(call: Call) -> Result<Value, Value> {
    call(json!({"op": "ping"})).map_err(|e| refused("no_host", e.to_string()))
}

fn folded(spec: &Spec) -> Result<Fold, Value> {
    crate::fold(&spec.dir, true)
        .map(|f| f.fold)
        .map_err(|e| refused("read", e.to_string()))
}

fn write(spec: &Spec, op: &mut Op, phase: &str) -> Result<(), Value> {
    op.phase = phase.into();
    let bytes = serde_json::to_vec(op).map_err(|e| refused("write", e.to_string()))?;
    write_atomic(&spec.dir.join(OP), &bytes).map_err(|e| refused("write", e.to_string()))?;
    crash_at(phase);
    Ok(())
}

/// Drill hook: a rewind that dies just after this step.
fn crash_at(step: &str) {
    if std::env::var("BRIGADIER_CRASH_AT").is_ok_and(|at| at == format!("rewind:{step}")) {
        std::process::abort();
    }
}

fn clear(spec: &Spec) -> io::Result<()> {
    fs::remove_file(spec.dir.join(OP))
}

/// Puts the folder back as it was just before this rewind.
fn undo(spec: &Spec, op: &Op) -> io::Result<()> {
    if let (Some(pre), Some(store)) = (&op.pre, Store::of(spec)) {
        store.write_back(&pre.tree, &op.paths)?;
    }
    Ok(())
}

fn cut<'a>(op: &'a Op) -> Cut<'a> {
    Cut {
        kept: op.kept.as_ref(),
        dropped: &op.dropped,
    }
}

/// Records the rewind in the log, once, only where the session is still between turns.
fn note(spec: &Spec, op: &Op, call: Call) -> Result<(), String> {
    let done = op.done.clone().unwrap_or_default();
    let data = json!({"event": "rewound", "op": op.op, "to": op.cid, "backend": op.backend,
        "fresh": done.fresh, "moved": done.moved, "pin": done.pin});
    for _ in 0..40 {
        let len = call(json!({"op": "ping"})).map_err(|e| e.to_string())?["len"].clone();
        let f = crate::fold(&spec.dir, true)
            .map_err(|e| e.to_string())?
            .fold;
        if f.rewinds.contains(&op.op) {
            return Ok(());
        }
        if !f.turns.is_empty() {
            return Err("a turn started during the rewind".into());
        }
        let reply =
            call(json!({"op": "note", "data": data, "if_len": len})).map_err(|e| e.to_string())?;
        if reply["ok"] == true {
            return Ok(());
        }
        if reply["error"] != "changed" {
            return Err(reply["error"].to_string());
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err("the session kept changing".into())
}

fn landed(spec: &Spec, f: &Fold, op: &Op) -> Landing {
    match adapters::get(&op.backend) {
        Some(a) => a.landed(
            &as_run(spec, f, &op.backend, None),
            &op.resume,
            &cut(op),
            op.at,
        ),
        None => Landing::Unknown(format!("unknown agent {}", op.backend)),
    }
}

/// A restore's reply never reads as complete when something stayed as it was [D384].
fn reply(op: &Op) -> Value {
    let complete = op.hand.is_empty() && op.left_out.is_empty();
    json!({"ok": true, "op": op.op, "restored": op.paths.len(), "hand": op.hand,
        "leftOut": op.left_out, "commits": op.commits, "complete": complete})
}

/// The outcome can't be told: said plainly, and the record stays until it can [D54, D300].
fn uncertain(why: &str) -> Value {
    refused(
        "uncertain",
        format!(
            "Brigadier can't tell whether the agent cut this conversation ({why}). Nothing more will run here until it can."
        ),
    )
}

fn finish(spec: &Spec, op: &mut Op, done: Rewound, call: Call) -> Value {
    op.done = Some(done);
    if let Err(e) = write(spec, op, "landed") {
        return e;
    }
    if let Err(why) = note(spec, op, call) {
        return refused(
            "unfinished",
            format!("The rewind didn't finish: {why}. It finishes before the next message."),
        );
    }
    let _ = clear(spec);
    reply(op)
}

fn rolled_back(spec: &Spec, op: &Op, why: String) -> Value {
    match undo(spec, op).and_then(|()| clear(spec)) {
        Ok(()) => refused("refused", why),
        Err(e) => refused(
            "unfinished",
            format!("{why}. Putting the files back failed too: {e}"),
        ),
    }
}

/// Rewinds to `cid`, fenced from the eligibility check to the end: the caller holds the queue's
/// lock and has seen it empty; `live` reads the session's host and its background work.
pub fn apply(
    data: &Path,
    spec: &Spec,
    op: &str,
    cid: &str,
    restore: bool,
    call: Call,
    live: &dyn Fn(&Fold) -> Live,
) -> io::Result<Value> {
    let (fence, mut checkout) = session::fence(data, spec)?;
    let _fence = fence;
    // The shared lock is this process's own: exchanged, or the exclusive one would wait on it.
    let _exclusive = if restore && local(data, spec) {
        checkout.take();
        Some(checkout_lock(data, true)?)
    } else {
        None
    };
    Ok(run(data, spec, op, cid, restore, call, live).unwrap_or_else(|e| e))
}

fn run(
    data: &Path,
    spec: &Spec,
    op: &str,
    cid: &str,
    restore: bool,
    call: Call,
    live: &dyn Fn(&Fold) -> Live,
) -> Result<Value, Value> {
    let mut host = ping(call)?;
    let mut f = folded(spec)?;
    if f.rewinds.contains(op) {
        return Ok(json!({"ok": true, "op": op, "already": true}));
    }
    gate(&f, &live(&f), &host, cid)?;
    // An idle child still holds the old conversation in memory.
    if host["child"].is_number() {
        let by = json!({"op": "stop", "by": "rewind"});
        call(by).map_err(|e| refused("no_host", e.to_string()))?;
        let started = Instant::now();
        loop {
            host = ping(call)?;
            if host["child"].is_null() {
                break;
            }
            if started.elapsed() > STOP_WAIT {
                return Err(refused("running", "The agent didn't stop in time."));
            }
            thread::sleep(Duration::from_millis(50));
        }
        f = folded(spec)?;
        gate(&f, &live(&f), &host, cid)?;
    }
    let (kept, mut turns) = f
        .range(cid)
        .ok_or_else(|| refused("gone", "This message can't be rewound to any more."))?;
    let files = if restore {
        let p = plan_for(data, spec, &f, cid)
            .map_err(|why| refused("no_restore", format!("The files can't go back ({why}).")))?;
        Some(p)
    } else {
        None
    };
    let backend = f.backend.clone();
    let adapter = adapters::get(&backend)
        .ok_or_else(|| refused("gone", format!("unknown agent {backend}")))?;
    let resume = (f.resume.get(&backend).cloned())
        .ok_or_else(|| refused("gone", "This conversation has no record to cut."))?;
    let (mut pre, mut target, mut paths) = (None, None, BTreeSet::new());
    let (mut hand, mut left_out, mut commits) = (vec![], vec![], false);
    if let Some(p) = files {
        (pre, target, paths) = (Some(p.pre), Some(p.target), p.paths);
        (hand, left_out, commits) = (p.hand, p.left_out, p.commits);
    }
    let mut record = Op {
        phase: String::new(),
        op: op.into(),
        cid: cid.into(),
        backend: backend.clone(),
        resume: resume.clone(),
        at: now_ms(),
        kept,
        dropped: turns.remove(0),
        pre,
        target,
        paths,
        hand,
        left_out,
        commits,
        done: None,
    };
    write(spec, &mut record, "prepared")?;
    if let (Some(target), Some(store)) = (record.target.clone(), Store::of(spec)) {
        write(spec, &mut record, "files")?;
        if let Err(e) = store.write_back(&target, &record.paths) {
            return Err(rolled_back(
                spec,
                &record,
                format!("The files couldn't go back: {e}"),
            ));
        }
    }
    write(spec, &mut record, "conversation")?;
    let run = as_run(spec, &f, &backend, None);
    let outcome = adapter.rewind(&run, &resume, &cut(&record));
    crash_at("cut");
    Ok(match outcome {
        Ok(done) => finish(spec, &mut record, done, call),
        Err(Failed::Refused(why)) => rolled_back(spec, &record, why),
        Err(Failed::Uncertain(why)) => match landed(spec, &f, &record) {
            Landing::Applied(done) => finish(spec, &mut record, done, call),
            Landing::NotApplied => rolled_back(spec, &record, why),
            Landing::Unknown(more) => uncertain(&format!("{why}; {more}")),
        },
    })
}

/// Whether a rewind cut short waits to be settled.
pub fn pending(dir: &Path) -> bool {
    dir.join(OP).exists()
}

/// Finishes or rolls back a rewind cut short, by the phase it reached. The caller holds the
/// queue's lock. A conversation cut is never tried again without proof it didn't happen.
pub fn settle(spec: &Spec, call: Call) -> io::Result<()> {
    let _one = worktrees::lock(&spec.dir)?;
    let Ok(bytes) = fs::read(spec.dir.join(OP)) else {
        return Ok(());
    };
    let mut op: Op = serde_json::from_slice(&bytes)?;
    let f = crate::fold(&spec.dir, true)?.fold;
    let unsettled = |v: Value| io::Error::other(v["message"].as_str().unwrap_or("").to_string());
    match op.phase.as_str() {
        "prepared" => clear(spec),
        "files" => undo(spec, &op).and_then(|()| clear(spec)),
        "landed" => {
            note(spec, &op, call).map_err(io::Error::other)?;
            clear(spec)
        }
        _ if f.rewinds.contains(&op.op) => clear(spec),
        _ => match landed(spec, &f, &op) {
            Landing::Applied(done) => match finish(spec, &mut op, done, call) {
                v if v["ok"] == true => Ok(()),
                v => Err(unsettled(v)),
            },
            Landing::NotApplied => undo(spec, &op).and_then(|()| clear(spec)),
            Landing::Unknown(why) => Err(unsettled(uncertain(&why))),
        },
    }
}

/// At the daemon's start: rewinds a crash cut short that no client has come back to.
pub fn cut_short(data: &Path) -> Vec<String> {
    (crate::ids(data).into_iter())
        .filter(|id| pending(&session_dir(data, id)))
        .collect()
}
