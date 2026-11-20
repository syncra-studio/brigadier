//! Going back to one of the user's own messages [D378, D384]: the conversation is cut at that
//! turn through its agent's own support, and on request the folder goes back too, from Brigadier's
//! own snapshots. Each phase is written down first, so one cut short finishes or rolls back on
//! proof before anything else runs [D54, D300].

mod active;
pub mod fork;
mod plan;
mod repos;
mod shared;
mod snap;
mod undo;

use crate::adapters::{self, Cut, Failed, Landing, Rewound};
use crate::fold::{Boundary, Fold, Live, Owner};
use crate::{Call, CallIn, Spec, as_run, session, session_dir, worktrees, write_atomic};
pub use active::{Active, read_active};
use brigadier_frames::log::now_ms;
pub use fork::{end_of, now_of, write_shot};
use plan::plan_for;
use repos::Part;
pub use repos::claimed;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use shared::Lives;
use snap::Record;
pub use snap::{Shot, Store};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};
pub use undo::undo_restore;

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
    /// Of `left_out`, the nested repositories.
    #[serde(default)]
    nested: Vec<String>,
    commits: bool,
    done: Option<Rewound>,
    /// A folder chat's claimed repos: each one's restore, and those that stay [D13].
    #[serde(default)]
    repos: Vec<Part>,
    #[serde(default)]
    stale: Vec<String>,
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
    for store in Store::of(spec).into_iter().chain(repos::stores(spec)) {
        ended(&store, f);
        if store.load(cid).is_none()
            && let Ok(before) = store.capture()
        {
            let _ = store.save(cid, &Record { before, end: None });
        }
    }
}

/// Takes the folder as the last turn ended. Too late, the edits may be the user's, not the agent's,
/// and it stays missing: that range offers keep only.
pub fn ends(spec: &Spec, f: &Fold) {
    for store in Store::of(spec).into_iter().chain(repos::stores(spec)) {
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

/// What the confirmation shows: whether the folder can go back, and what it would and wouldn't do.
pub fn preview(data: &Path, spec: &Spec, f: &Fold, cid: &str, live: Lives) -> Value {
    if !f.points().iter().any(|p| p == cid) {
        return refused("gone", "This message can't be rewound to any more.");
    }
    match plan_for(data, spec, f, cid, live) {
        Ok(p) => {
            let paths = (p.paths.iter().cloned()).chain(repos::named(&p.repos));
            json!({"ok": true, "restore": true, "paths": paths.collect::<Vec<_>>(), "hand": p.hand,
            "leftOut": p.left_out, "nested": p.nested, "commits": p.commits, "stale": p.stale})
        }
        Err((why, with)) => json!({"ok": true, "restore": false, "why": why, "with": with}),
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

/// Puts the folder back as it was just before this rewind, only where it's still as the restore
/// left it: a path changed since keeps its edit, another session's in a shared folder [D1078].
fn undo(spec: &Spec, op: &Op) -> io::Result<()> {
    if let (Some(pre), Some(target), Some(store)) = (&op.pre, &op.target, Store::of(spec)) {
        undo::put_back(&store, &pre.tree, target, &op.paths)?;
    }
    repos::put_back(spec, &op.repos).map(drop)
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
        "fresh": done.fresh, "moved": done.moved, "pin": done.pin, "turns": done.turns});
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
    let complete = op.hand.is_empty() && op.left_out.is_empty() && op.stale.is_empty();
    let restored = op.paths.len() + repos::named(&op.repos).len();
    json!({"ok": true, "op": op.op, "restored": restored, "hand": op.hand, "stale": op.stale,
        "leftOut": op.left_out, "nested": op.nested, "commits": op.commits, "complete": complete})
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
    if let Err(e) = undo::close(spec, op) {
        return refused(
            "unfinished",
            format!("The rewind didn't finish: {e}. It finishes before the next message."),
        );
    }
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
/// lock and has seen it empty; `live` reads a session's host and its background work, this one's
/// and any other's in its folder [D1078].
pub fn apply(
    data: &Path,
    spec: &Spec,
    op: &str,
    cid: &str,
    restore: bool,
    call: Call,
    live: &dyn Fn(&Spec, &Fold) -> Live,
) -> io::Result<Value> {
    let (fence, mut checkout) = session::fence(data, spec)?;
    let _fence = fence;
    // The shared lock is this process's own: exchanged, or the exclusive one would wait on it.
    // Every restore takes it: another session may share even a worktree [D1070, D1089].
    let _exclusive = if restore {
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
    live: &dyn Fn(&Spec, &Fold) -> Live,
) -> Result<Value, Value> {
    let mut host = ping(call)?;
    let mut f = folded(spec)?;
    if f.rewinds.contains(op) {
        return Ok(json!({"ok": true, "op": op, "already": true}));
    }
    gate(&f, &live(spec, &f), &host, cid)?;
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
        gate(&f, &live(spec, &f), &host, cid)?;
    }
    let (kept, mut turns) = f
        .range(cid)
        .ok_or_else(|| refused("gone", "This message can't be rewound to any more."))?;
    let files = if restore {
        let p = plan_for(data, spec, &f, cid, live).map_err(|(why, with)| {
            let named = with.and_then(|id| crate::load(data, &id).ok());
            refused(
                "no_restore",
                match named {
                    Some(o) if why == "busy" => format!(
                        "Files stay: {} is working in this folder now.",
                        crate::share::title(&o)
                    ),
                    Some(o) => format!(
                        "Files stay: {} was working in this folder during this turn.",
                        crate::share::title(&o)
                    ),
                    None => format!("The agent's file changes can't be undone ({why})."),
                },
            )
        })?;
        Some(p)
    } else {
        None
    };
    let backend = f.backend.clone();
    let adapter = adapters::get(&backend)
        .ok_or_else(|| refused("gone", format!("unknown agent {backend}")))?;
    let resume = (f.resume.get(&backend).cloned())
        .ok_or_else(|| refused("gone", "This conversation has no record to cut."))?;
    let p = files.unwrap_or_default();
    let mut record = Op {
        phase: String::new(),
        op: op.into(),
        cid: cid.into(),
        backend: backend.clone(),
        resume: resume.clone(),
        at: now_ms(),
        kept,
        dropped: turns.remove(0),
        pre: p.pre,
        target: p.target,
        paths: p.paths,
        hand: p.hand,
        left_out: p.left_out,
        nested: p.nested,
        commits: p.commits,
        done: None,
        repos: p.repos,
        stale: p.stale,
    };
    write(spec, &mut record, "prepared")?;
    let main = record.target.clone().zip(Store::of(spec));
    if main.is_some() || !record.repos.is_empty() {
        write(spec, &mut record, "files")?;
        let wrote = (main.map_or(Ok(()), |(target, store)| {
            store.write_back(&target, &record.paths)
        }))
        .and_then(|()| repos::write_back(spec, &record.repos));
        if let Err(e) = wrote {
            return Err(rolled_back(
                spec,
                &record,
                format!("The agent's file changes couldn't be undone: {e}"),
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

/// Whether a rewind or a fork cut short waits to be settled.
pub fn pending(dir: &Path) -> bool {
    dir.join(OP).exists() || dir.join(fork::OP).exists()
}

/// Finishes or rolls back a rewind cut short, by the phase it reached. The caller holds the
/// queue's lock. A conversation cut is never tried again without proof it didn't happen.
/// `call_in` reaches a fork's own host, for its record.
pub fn settle(spec: &Spec, call: Call, call_in: CallIn) -> io::Result<()> {
    let _one = worktrees::lock(&spec.dir)?;
    fork::settle(spec, call_in)?;
    let Ok(bytes) = fs::read(spec.dir.join(OP)) else {
        return Ok(());
    };
    let mut op: Op = serde_json::from_slice(&bytes)?;
    let f = crate::fold(&spec.dir, true)?.fold;
    let unsettled = |v: Value| io::Error::other(v["message"].as_str().unwrap_or("").to_string());
    // An undo writes into a folder other sessions may use: none starts a turn meanwhile [D1089].
    let undo = |op: &Op| {
        checkout_lock(&crate::data_of(spec), true)
            .and_then(|_checkout| undo(spec, op))
            .and_then(|()| clear(spec))
    };
    match op.phase.as_str() {
        "prepared" => clear(spec),
        "files" => undo(&op),
        "landed" => {
            note(spec, &op, call).map_err(io::Error::other)?;
            undo::close(spec, &op)
        }
        _ if f.rewinds.contains(&op.op) => undo::close(spec, &op),
        _ => match landed(spec, &f, &op) {
            Landing::Applied(done) => match finish(spec, &mut op, done, call) {
                v if v["ok"] == true => Ok(()),
                v => Err(unsettled(v)),
            },
            Landing::NotApplied => undo(&op),
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
