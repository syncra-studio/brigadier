//! The follow-up queue [D183, D188]: messages that wait for the running turn, kept in the session
//! folder (`queue.json`, under `queue.lock`), sent one at a time by the daemon once the session is
//! between turns, paused by Stop until Resume [D40, D71, D109, D159]. Each message goes under its
//! own id as its command id, so the log proves whether it went and nothing is sent twice [D54].

use crate::{arg, control, flag, index, owner};
use brigadier_core::fold::{self, Owner};
use brigadier_core::{self as core, check_id};
use brigadier_frames::{procs, take_lock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::Path;
use std::thread;

mod peer;
mod to;
pub use peer::{add_peer, pending};
pub use to::held as give_held;

#[derive(Serialize, Deserialize, Default, PartialEq)]
struct Queue {
    paused: bool,
    /// A Stop is under way: whatever is added meanwhile waits for Resume.
    #[serde(default)]
    stopping: bool,
    items: Vec<Item>,
    /// A message pulled back to edit, kept here until it is put back or sent: the drain skips it.
    #[serde(default)]
    editing: Option<Editing>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
struct Item {
    id: String,
    text: String,
    /// The composer's draft it was queued as, its files already in the session's folder [D127].
    #[serde(default, skip_serializing_if = "Value::is_null")]
    parts: Value,
    at: u64,
    /// Why the drain couldn't send it: it stays first, and the queue waits on it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Another session's message, `peer:<id>` [D2034]: never the user's. None is the user's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    origin: Option<String>,
    /// The user's message for this worker of the session's (the To chip), held while it works.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    to: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
struct Editing {
    id: String,
    text: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    parts: Value,
    slot: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    to: Option<String>,
}

fn read(dir: &Path) -> io::Result<Queue> {
    match fs::read(dir.join("queue.json")) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Queue::default()),
        Err(e) => Err(e),
    }
}

/// Changes the queue under its lock; a change is written as a new file renamed into place.
fn change<T>(dir: &Path, f: impl FnOnce(&mut Queue) -> io::Result<T>) -> io::Result<T> {
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("queue.lock"))?;
    lock.lock()?;
    locked(dir, f)
}

/// Holds the queue still until the guard drops, and says whether anything waits or is being edited.
pub fn hold(dir: &Path) -> io::Result<(fs::File, bool)> {
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("queue.lock"))?;
    lock.lock()?;
    let q = read(dir)?;
    // A message for a worker never goes here.
    let mine = q.items.iter().any(|i| i.to.is_none());
    Ok((
        lock,
        mine || q.editing.as_ref().is_some_and(|e| e.to.is_none()),
    ))
}

/// The same, for a caller that holds the lock.
fn locked<T>(dir: &Path, f: impl FnOnce(&mut Queue) -> io::Result<T>) -> io::Result<T> {
    let was = read(dir)?;
    let mut q = read(dir)?;
    let out = f(&mut q)?;
    if q.items.is_empty() && !q.stopping {
        q.paused = false;
    }
    if q != was {
        core::write_atomic(&dir.join("queue.json"), &serde_json::to_vec(&q)?)?;
    }
    Ok(out)
}

/// What a row shows: the queue, or null when nothing waits or is being edited.
pub fn row(dir: &Path) -> Value {
    match read(dir) {
        Ok(q) if !q.items.is_empty() || q.editing.is_some() => json!(q),
        _ => Value::Null,
    }
}

fn missing(what: &str) -> io::Error {
    io::Error::other(format!("no queued message {what}"))
}

/// `queue <id> add <text> --qid Q [--at N] | move <qid> <to> | remove <qid> | edit <qid> |
/// restore | steer <qid> | resume`. Each answers the folder's time after its write, which the
/// row reaches once it shows the change [D30].
pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    core::load(data, id)?;
    let dir = core::session_dir(data, id);
    let qid = || arg(args, 3).map(String::from);
    match arg(args, 2)? {
        "add" => {
            let text = arg(args, 3)?.to_string();
            let qid = flag(args, "--qid").ok_or_else(|| io::Error::other(crate::USAGE))?;
            check_id(qid)?;
            let at = flag(args, "--at").and_then(|n| n.parse().ok());
            let parts = crate::parts(args)?;
            core::message::take(data, &dir, &parts, flag(args, "--from"))?;
            // Only another session's message names its sender; anything else is the user's [D2034].
            let origin = flag(args, "--origin").map(String::from);
            if origin.as_ref().is_some_and(|o| !o.starts_with("peer:")) {
                return Err(io::Error::other("--origin takes only peer:<id>"));
            }
            let to = flag(args, "--to").map(String::from);
            if let Some(wid) = &to {
                to::check(data, id, wid)?;
            }
            change(&dir, |q| {
                // Sending an edited message puts it back: the edit is over.
                if q.editing.as_ref().is_some_and(|e| e.id == qid) {
                    q.editing = None;
                }
                let item = Item {
                    id: qid.into(),
                    text,
                    parts,
                    at: brigadier_frames::log::now_ms(),
                    error: None,
                    origin,
                    to: to.clone(),
                };
                // The same id again (a retry) replaces it in place.
                match q.items.iter_mut().find(|i| i.id == qid) {
                    Some(old) => *old = item,
                    None => {
                        let slot = at.unwrap_or(q.items.len()).min(q.items.len());
                        q.items.insert(slot, item);
                    }
                }
                q.paused |= q.stopping;
                // A worker between turns takes it at once.
                match to.as_deref().and_then(|wid| to::first(q, wid)) {
                    Some(first) => to::give(data, id, q, &first, false).map(drop),
                    None => Ok(()),
                }
            })?;
        }
        "move" => {
            let (qid, to) = (qid()?, arg(args, 4)?);
            let to: usize = to.parse().map_err(|_| io::Error::other(crate::USAGE))?;
            change(&dir, |q| {
                let from = q.items.iter().position(|i| i.id == qid);
                let item = q.items.remove(from.ok_or_else(|| missing(&qid))?);
                q.items.insert(to.min(q.items.len()), item);
                Ok(())
            })?;
        }
        "remove" => {
            let qid = qid()?;
            change(&dir, |q| {
                q.items.retain(|i| i.id != qid);
                if q.editing.as_ref().is_some_and(|e| e.id == qid) {
                    q.editing = None;
                }
                Ok(())
            })?;
        }
        "edit" => {
            let qid = qid()?;
            change(&dir, |q| {
                restore(q);
                let slot = q.items.iter().position(|i| i.id == qid);
                let item = q.items.remove(slot.ok_or_else(|| missing(&qid))?);
                let slot = slot.unwrap_or(0);
                q.editing = Some(Editing {
                    id: item.id,
                    text: item.text,
                    parts: item.parts,
                    slot,
                    origin: item.origin,
                    to: item.to,
                });
                Ok(())
            })?;
        }
        "restore" => change(&dir, |q| {
            restore(q);
            Ok(())
        })?,
        // Into the running turn under its queued id: gone from the queue once the log has it.
        "steer" => {
            let qid = qid()?;
            let (reply, went) = change(&dir, |q| {
                let item = q
                    .items
                    .iter()
                    .find(|i| i.id == qid)
                    .ok_or_else(|| missing(&qid))?;
                if item.to.is_some() {
                    let n = q.items.len();
                    return Ok(match to::give(data, id, q, &qid, true)? {
                        Some(reply) => (reply, q.items.len() < n),
                        None => (Value::Null, true),
                    });
                }
                let origin = item.origin.as_deref().unwrap_or("user");
                let reply = control::steer_as(
                    data,
                    id,
                    &item.text.clone(),
                    &item.parts.clone(),
                    Some(&qid),
                    origin,
                )?;
                let went = went(&dir, &reply, &qid);
                if went {
                    q.items.retain(|i| i.id != qid);
                }
                Ok((reply, went))
            })?;
            if !went {
                return Ok(reply);
            }
        }
        // A stopped turn carries on first, under the queue's lock and before it unpauses, so nothing
        // queued can go ahead of it; refused, the queue stays paused and says why [D237, D373].
        "resume" => {
            let refused = change(&dir, |q| {
                let f = core::fold(&dir, true)?.fold;
                let live = fold::live(&f, owner::state(data, id), data, &procs::all());
                let status = fold::status(&f, &live);
                if fold::resumable(&f, status["state"].as_str().unwrap_or("")) {
                    let reply = recover(data, id, true)?;
                    let went = matches!(reply["result"].as_str(), Some("delivered" | "logged"));
                    if reply["ok"] != true && !went {
                        return Ok(Some(reply));
                    }
                }
                go_on(q);
                Ok(None)
            })?;
            if let Some(reply) = refused {
                return Ok(reply);
            }
        }
        _ => return Err(io::Error::other(crate::USAGE)),
    }
    Ok(json!({"ok": true, "at": index::touched(&dir)}))
}

/// Lets a paused queue go without carrying its stopped turn on: a worker's Resume, whose
/// "Continue where you stopped." is that turn's one carry-on, as the old app's [D3049].
pub fn release(dir: &Path) -> io::Result<()> {
    change(dir, |q| {
        go_on(q);
        Ok(())
    })
}

fn go_on(q: &mut Queue) {
    (q.paused, q.stopping) = (false, false);
    if let Some(first) = q.items.first_mut() {
        first.error = None;
    }
}

/// The message being edited goes back to its place, unchanged.
fn restore(q: &mut Queue) {
    if let Some(e) = q.editing.take() {
        let slot = e.slot.min(q.items.len());
        let at = brigadier_frames::log::now_ms();
        let item = Item {
            id: e.id,
            text: e.text,
            parts: e.parts,
            at,
            error: None,
            origin: e.origin,
            to: e.to,
        };
        q.items.insert(slot, item);
    }
}

/// Whether a message reached the log under `cid`: delivered, logged though not proven delivered
/// (never sent again by itself), or found there.
fn went(dir: &Path, reply: &Value, cid: &str) -> bool {
    matches!(reply["result"].as_str(), Some("delivered" | "logged"))
        || core::fold(dir, true).is_ok_and(|f| f.fold.cids.contains_key(cid))
}

/// Stop [D159]: the queue is paused first, so nothing goes on while the turn ends, and stays paused
/// if anything waits, including what was added during the Stop. Then the agent's own stop, and the
/// kill only when it has none or it didn't stop in time. `by`: "user", or "pause" for a worker's Pause.
pub fn stop(data: &Path, id: &str, by: &str) -> io::Result<Value> {
    let dir = core::session_dir(data, id);
    change(&dir, |q| {
        (q.paused, q.stopping) = (true, true);
        Ok(())
    })?;
    let stopped = (|| {
        if let Ok(Some(stopped)) = control::interrupt(data, id, by) {
            return Ok(stopped);
        }
        match owner::call(data, id, json!({"op": "stop", "by": by})) {
            Ok(v) => Ok(v),
            // No owner: nothing can be running under us, but leftovers recorded in the log still go.
            Err(e) => {
                let f = core::fold(&dir, true)?;
                Ok(json!({"ok": true, "owner": e.to_string(), "swept": core::sweep(&f.fold, &dir)}))
            }
        }
    })();
    change(&dir, |q| {
        q.stopping = false;
        Ok(())
    })?;
    stopped
}

/// The states a session takes its next queued message in: between turns, however the last ended
/// but at a limit, a sign-in or a cut-off run, which need the user (D237).
const DRAINS: [&str; 4] = ["idle", "idle_jobs", "stopped", "failed"];

/// The daemon's pass: each session between turns whose queue waits and isn't paused sends its
/// first message, off the daemon's loop; a worker's go to it once it's free.
pub fn drain(data: &Path, rows: &BTreeMap<String, Value>) {
    to::pass(data, rows);
    for (id, row) in rows {
        let q = &row["queue"];
        let mine = q["items"].as_array().into_iter().flatten();
        let first = mine
            .into_iter()
            .find(|i| i["to"].is_null())
            .unwrap_or(&Value::Null);
        let state = row["state"].as_str().unwrap_or("");
        if !first.is_object()
            || q["paused"] == true
            || !first["error"].is_null()
            || !DRAINS.contains(&state)
            // A rebirth due goes first: what's queued lands in its fresh conversation [D88].
            || !row["rebirth"].is_null()
        {
            continue;
        }
        let (data, id) = (data.to_path_buf(), id.clone());
        thread::spawn(move || {
            if let Err(e) = send_first(&data, &id) {
                eprintln!("brigadierd: queue {id}: {e}");
            }
        });
    }
}

/// Sends the first queued message, judged and sent under the queue's lock (another pass that finds
/// it held leaves it). The host takes it only if nothing reached the log since the session was
/// judged between turns; a changed session keeps it queued. It leaves the queue only once the log
/// has it; a refusal stays on it, and the queue waits there.
fn send_first(data: &Path, id: &str) -> io::Result<()> {
    let dir = core::session_dir(data, id);
    let Some(_lock) = take_lock(&dir.join("queue.lock"))? else {
        return Ok(());
    };
    let spec = core::load(data, id)?;
    crate::rewind::settle_held(data, &spec)?;
    locked(&dir, |q| {
        let at = q.items.iter().position(|i| i.to.is_none()).unwrap_or(0);
        let Some(item) = (q.items.get(at))
            .filter(|i| !q.paused && i.to.is_none() && i.error.is_none())
            .cloned()
        else {
            return Ok(());
        };
        if core::fold(&dir, true)?.fold.cids.contains_key(&item.id) {
            q.items.remove(at);
            return Ok(());
        }
        owner::ensure(data, &spec)?;
        let ping = owner::call(data, id, json!({"op": "ping"}))?;
        let Some(len) = ping["len"].as_u64() else {
            return Ok(());
        };
        let f = core::fold(&dir, true)?;
        let live = fold::live(&f.fold, owner::state(data, id), data, &procs::all());
        let status = fold::status(&f.fold, &live);
        if live.owner != Owner::Alive || !DRAINS.contains(&status["state"].as_str().unwrap_or("")) {
            return Ok(());
        }
        let child = ping["child"]
            .as_i64()
            .map(|_| ping["spawn"].as_u64().unwrap_or(0));
        let call = |mut req: Value| {
            // A replace judges idleness itself, later: its own guard stands.
            if req["if_len"].is_null() && matches!(req["op"].as_str(), Some("input" | "spawn")) {
                req["if_len"] = len.into();
            }
            owner::call(data, id, req)
        };
        let mut msg = core::message::compose(&spec, &item.text, item.parts.clone())?;
        // What's held for the parent's next message goes with it [D329].
        let held = crate::workers::with_next(data, id, &mut msg.agent);
        let reply = core::send(
            &crate::routing::told(data, &spec),
            &f.fold,
            child,
            &call,
            &item.id,
            item.origin.as_deref().unwrap_or("user"),
            &msg,
            None,
            None,
        );
        if went(&dir, &reply, &item.id) {
            crate::workers::went_with(data, id, held);
            q.items.remove(at);
        } else if reply["error"] != "changed" {
            let why = reply["message"]
                .as_str()
                .or(reply["error"].as_str())
                .unwrap_or("refused");
            q.items[at].error = Some(why.into());
        }
        Ok(())
    })
}

/// Rust's one recovery for a session; `queued`: the caller holds its queue's lock.
pub fn recover(data: &Path, id: &str, queued: bool) -> io::Result<Value> {
    let spec = core::load(data, id)?;
    owner::ensure(data, &spec)?;
    let settle = if queued {
        crate::rewind::settle_held
    } else {
        crate::rewind::settled
    };
    settle(data, &spec)?;
    let _fence = core::session::fence(data, &spec)?;
    let f = core::fold(&spec.dir, true)?;
    let live = fold::live(&f.fold, Owner::Alive, data, &procs::all());
    let call = crate::call_fn(data, id);
    // The user's Resume takes what's held for the session, as their next message would [D329].
    let mut more = String::new();
    let held = match queued {
        true => crate::workers::with_next(data, id, &mut more),
        false => vec![],
    };
    let reply = core::recover(&spec, &f.fold, &live, crate::child(data, id), &call, &more);
    if matches!(reply["result"].as_str(), Some("delivered" | "logged")) {
        crate::workers::went_with(data, id, held);
    }
    Ok(reply)
}
