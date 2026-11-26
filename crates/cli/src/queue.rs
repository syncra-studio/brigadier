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

mod cut;
mod drain;
mod judge;
mod peer;
mod stop;
mod to;
pub mod wake;

pub use cut::{goes_on, off as cut_off, recover};
pub use drain::{drain, takes, will_go};
pub(crate) use peer::own;
pub use peer::{UNSURE, add_peer, pending, send_back, waits_for};
pub use stop::stop;
pub use to::held as give_held;

#[derive(Serialize, Deserialize, Default, PartialEq)]
struct Queue {
    paused: bool,
    /// A Stop is under way: whatever is added meanwhile waits for Resume.
    #[serde(default)]
    stopping: bool,
    items: Vec<Item>,
    /// The user's `!` commands running now that their messages wait for, till one ends or is sent to
    /// the background.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    running: Vec<String>,
    /// A message pulled back to edit, kept here until it is put back or sent: the drain skips it.
    #[serde(default)]
    editing: Option<Editing>,
}

#[derive(Serialize, Deserialize, Default, Clone, PartialEq)]
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
    /// Being judged whether it joins the work in progress (`judge`): its row reads Deciding [D521].
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    deciding: bool,
    /// Decided to join a block its workers or subagents hold open: it may go now.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    fits: bool,
    /// Why it waits, once judged: the judge said so (`judged`), gave no answer in time (`late`) or
    /// couldn't (`failed`). Kept through a restart: it isn't judged again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    waits: Option<String>,
    /// The user's `!` command: `wait` till its turn to run, `ended` as its report to the agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shell: Option<String>,
}

impl Item {
    /// Whether it goes to this session as the user's own: not another session's, not a worker's.
    fn own(&self) -> bool {
        self.to.is_none() && self.origin.is_none()
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shell: Option<String>,
}

impl Queue {
    /// Whether its item `at` may go to this session now: the one rule of the drain, a worker's
    /// result and the judge. While a command runs the user's messages wait, and the commands behind
    /// it; a command's report and another session's message don't. While workers or subagents hold
    /// its block open, `held` is when its agent last dealt with a worker's result: one that fits goes
    /// as the block's next turn, the rest of the user's, all decided, at the end of the turn that
    /// deals with the next worker's result, or of the block (repo-merge D39, D48, C29); a command
    /// that is first goes at once.
    fn goes(&self, at: usize, held: Option<u64>) -> bool {
        let i = &self.items[at];
        let open = held.is_none_or(|ended| {
            let decided = !self.items[..=at].iter().any(|i| i.deciding);
            let first = || self.items.iter().position(Item::own) == Some(at);
            i.fits || (decided && i.at < ended) || (i.shell.is_some() && first())
        });
        i.to.is_none()
            && (i.origin.is_some()
                || i.shell.as_deref() == Some("ended")
                || (self.running.is_empty() && open))
    }
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
    let _lock = hold(dir)?.0;
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
    let (was, mut q) = (read(dir)?, read(dir)?);
    let out = f(&mut q)?;
    if q.items.is_empty() && !q.stopping {
        q.paused = false;
    }
    if q != was {
        wake::write(dir, &q)?;
    }
    Ok(out)
}

/// What a row shows: the queue, or null when nothing waits, runs or is being edited.
pub fn row(dir: &Path) -> Value {
    match read(dir) {
        Ok(q) if !q.items.is_empty() || !q.running.is_empty() || q.editing.is_some() => {
            json!(q)
        }
        _ => Value::Null,
    }
}

fn missing(what: &str) -> io::Error {
    io::Error::other(format!("no queued message {what}"))
}

/// `queue <id> add <text> --qid Q [--at N] [--to W | --shell] | move <qid> <to> | remove <qid> | edit <qid> |
/// restore | steer <qid> | resume | background <command id>`. Each answers the folder's time after
/// its write, which the row reaches once it shows the change [D30].
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
            let (parts, from) = (crate::parts(args)?, flag(args, "--from"));
            let parts = core::message::notes::taken(data, &dir, parts, from)?;
            // Only another session's message names its sender; anything else is the user's [D2034].
            let origin = flag(args, "--origin").map(String::from);
            if origin.as_ref().is_some_and(|o| !o.starts_with("peer:")) {
                return Err(io::Error::other("--origin takes only peer:<id>"));
            }
            let to = flag(args, "--to").map(String::from);
            if let Some(wid) = &to {
                to::check(data, id, wid)?;
            }
            let shell = crate::has(args, "--shell").then(|| "wait".to_string());
            change(&dir, |q| {
                // Sending an edited message puts it back: the edit is over.
                if q.editing.as_ref().is_some_and(|e| e.id == qid) {
                    q.editing = None;
                }
                if shell.is_some() && crate::tabs::terminal::shell::begun(data, id, qid) {
                    return Ok(());
                }
                // A command it's put back as never ran.
                if shell.is_some() && at.is_none() && at_once(data, id, q)? {
                    crate::tabs::terminal::shell::start(data, id, qid, &text)?;
                    q.running.push(qid.into());
                    return Ok(());
                }
                let item = Item {
                    id: qid.into(),
                    text,
                    parts,
                    at: brigadier_frames::log::now_ms(),
                    deciding: origin.is_none()
                        && to.is_none()
                        && shell.is_none()
                        && judge::judges(data, id, q, qid, at),
                    shell,
                    origin,
                    to: to.clone(),
                    ..Item::default()
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
                let mut item = q.items.remove(from.ok_or_else(|| missing(&qid))?);
                // The user placed it: the judge's answer is dropped.
                (item.deciding, item.fits, item.waits) = (false, false, None);
                let to = to.min(q.items.len());
                // What goes after a command is steered nowhere by itself.
                if item.shell.is_some() {
                    q.items[to..].iter_mut().for_each(|i| i.deciding = false);
                }
                q.items.insert(to, item);
                Ok(())
            })?;
        }
        "remove" => {
            let qid = qid()?;
            change(&dir, |q| {
                let item = q.items.iter().find(|i| i.id == qid);
                // Its report goes, unless it can't.
                if item.is_some_and(|i| i.shell.as_deref() == Some("ended") && i.error.is_none()) {
                    return Err(io::Error::other("That command already ran"));
                }
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
                let ended = |i: &Item| i.shell.as_deref() == Some("ended");
                let slot = q.items.iter().position(|i| i.id == qid && !ended(i));
                let item = q.items.remove(slot.ok_or_else(|| missing(&qid))?);
                let slot = slot.unwrap_or(0);
                q.editing = Some(Editing {
                    id: item.id,
                    text: item.text,
                    parts: item.parts,
                    slot,
                    origin: item.origin,
                    to: item.to,
                    shell: item.shell,
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
                    .find(|i| i.id == qid && i.shell.is_none())
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
                    true,
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
        // What waits goes on though the command runs.
        "background" => {
            let cmd = qid()?;
            change(&dir, |q| {
                q.running.retain(|c| *c != cmd);
                Ok(())
            })?;
        }
        // A stopped turn carries on first, under the queue's lock and before it unpauses, so nothing
        // queued can go ahead of it; refused, the queue stays paused and says why [D237, D373].
        "resume" => {
            let _lock = cut::hold_all(data, id)?;
            let refused = locked(&dir, |q| {
                let (f, state) = cut::now(data, id)?;
                if fold::resumable(&f, &state) || cut::resumes(&dir, &f, &state, q) {
                    let reply = recover(data, id, true)?;
                    let went = matches!(
                        reply["result"].as_str(),
                        Some("delivered" | "logged" | "sent")
                    );
                    if reply["ok"] != true && !went {
                        // Its first message can't go either: it waits saying why, as a refused send's does [D392 P9].
                        if let Some(first) = q.items.first_mut() {
                            let why = reply["message"].as_str().or(reply["error"].as_str());
                            first.error = Some(why.unwrap_or("refused").into());
                        }
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

/// Whether a `!` command runs at once: no turn runs, no command waits or holds the queue, and
/// nothing of the user's goes first.
fn at_once(data: &Path, id: &str, q: &Queue) -> io::Result<bool> {
    let (f, state) = cut::now(data, id)?;
    let first = q.items.iter().find(|i| i.own());
    let goes = !q.paused
        && drain::DRAINS.contains(&state.as_str())
        && first.is_some_and(|i| i.error.is_none());
    let waits = q.items.iter().any(|i| i.shell.as_deref() == Some("wait"));
    Ok(f.turns.is_empty() && q.running.is_empty() && !waits && !goes)
}

/// A `!` command ended: its report waits for the agent ahead of what waits already but other
/// reports, under its own id, so it goes once [D54]. One begun before the user's Stop waits for
/// Resume, as a worker's result does [D95].
pub fn ended(data: &Path, id: &str, cmd: &str, kept: &Value) -> io::Result<()> {
    let dir = core::session_dir(data, id);
    change(&dir, |q| {
        q.running.retain(|c| c != cmd);
        q.items
            .retain(|i| i.id != cmd || i.shell.as_deref() == Some("ended"));
        if q.items.iter().any(|i| i.id == cmd) || went(&dir, &Value::Null, cmd) {
            return Ok(());
        }
        let text = kept["report"].as_str().unwrap_or_default().to_string();
        let shell = Some("ended".to_string());
        let item = Item {
            id: cmd.into(),
            parts: json!({"parts": [text], "attachmentIds": [], "shell": kept["line"]}),
            text,
            at: brigadier_frames::log::now_ms(),
            shell: shell.clone(),
            ..Item::default()
        };
        let slot = q.items.iter().take_while(|i| i.shell == shell).count();
        q.items.insert(slot, item);
        let (f, state) = cut::now(data, id)?;
        let halted = (f.last.as_ref().filter(|_| fold::resumable(&f, &state))).is_some_and(|l| {
            matches!(l["reason"].as_str(), Some("user" | "pause" | "lead"))
                && kept["from"].as_u64().unwrap_or(u64::MAX) < l["ts"].as_u64().unwrap_or(0)
        });
        q.paused |= q.stopping || halted;
        Ok(())
    })
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
            origin: e.origin,
            to: e.to,
            shell: e.shell,
            ..Item::default()
        };
        q.items.insert(slot, item);
    }
}

/// Whether a message reached the log under `cid`: delivered, logged though not proven delivered
/// (never sent again by itself), written to an agent whose reply is still to come, or found there.
fn went(dir: &Path, reply: &Value, cid: &str) -> bool {
    matches!(
        reply["result"].as_str(),
        Some("delivered" | "logged" | "sent")
    ) || core::fold(dir, true).is_ok_and(|f| f.fold.cids.contains_key(cid))
}
