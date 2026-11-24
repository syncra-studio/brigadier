//! Deciding, as the old app's [D521]: a message the user queues while the session's block works
//! reads "Deciding" on its row while one small model call judges it: a one-shot of the session's
//! own agent, on its account and its cheapest model, that reads what the session is at (`reads`) and
//! the message, and answers FITS or WAITS. The session's turn is never asked.
//!
//! - FITS, a late answer or none: it is steered into the open block, as the user's Steer does.
//!   When unsure it steers (proposed; the old app waited) [D771].
//! - WAITS: it stays queued, no longer Deciding, for its own turn.
//! - The user moved, edited, steered or deleted it meanwhile: the answer is dropped.
//!
//! Deciding is only a label: the row's actions stay usable and it never holds the queue. A paused
//! queue (after the user's Stop) judges nothing, and another session's message is never judged:
//! it goes in at once [D300].

use super::{DRAINS, Queue, change, read, went};
use crate::{commit, control, workers};
use brigadier_core::{self as core, writer};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::Duration;

mod reads;
use reads::Reads;

/// How long the judge may take before the message just steers (the old app's 5 s) [D771].
const PATIENCE: Duration = Duration::from_secs(5);

/// How many times, a second apart, a message that fits is tried while its block only starts, so
/// nothing can be steered into it yet: as long as an agent may take to start its turn.
const TRIES: u32 = 30;

/// Every message this daemon has judged or is judging: none is judged twice.
static JUDGED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// Whether the user's own message `qid`, added to `q` now, is judged: the queue isn't paused, it
/// isn't there already (a retry), and it isn't put back in a slot `at` after an edit.
pub(super) fn judges(q: &Queue, qid: &str, at: Option<usize>) -> bool {
    at.is_none() && !q.paused && !q.stopping && !q.items.iter().any(|i| i.id == qid)
}

/// The daemon's pass over one session's row: each message newly Deciding is judged off the
/// daemon's loop while the session's block works. Between turns it stays Deciding for a block that
/// starts before the drain sends it (a worker's result, a hand-off's fresh conversation); where no
/// drain will, it just waits its turn.
pub(super) fn pass(data: &Path, id: &str, row: &Value) {
    let q = &row["queue"];
    let items = || q["items"].as_array().into_iter().flatten();
    // A running turn takes it only from an agent that can be steered; a held block starts a turn.
    let busy = row["holding"] == true || (row["running"] == true && row["steer"] == true);
    let drains = DRAINS.contains(&row["state"].as_str().unwrap_or(""))
        && q["paused"] != true
        && items().all(|i| i["error"].is_null());
    if !busy && drains {
        return;
    }
    for qid in items()
        .filter(|i| i["deciding"] == true)
        .filter_map(|i| i["id"].as_str())
    {
        if !JUDGED.lock().unwrap().insert(qid.into()) {
            continue;
        }
        let (data, id, qid) = (data.to_path_buf(), id.to_string(), qid.to_string());
        thread::spawn(move || {
            let mut fits = busy && judge(&data, &id, &qid) != Some(false);
            for tried in 1.. {
                match settle(&data, &id, &qid, fits) {
                    Ok(true) => return,
                    Ok(false) => {}
                    Err(e) => eprintln!("brigadierd: judge {id}: {e}"),
                }
                // Out of tries it waits in the queue, no longer Deciding.
                fits &= tried < TRIES;
                if tried > TRIES {
                    return;
                }
                thread::sleep(Duration::from_secs(1));
            }
        });
    }
}

/// The judge's answer for queued `qid`, none when it gave none in time.
fn judge(data: &Path, id: &str, qid: &str) -> Option<bool> {
    let spec = core::load(data, id).ok()?;
    let item = read(&spec.dir)
        .ok()?
        .items
        .into_iter()
        .find(|i| i.id == qid)?;
    // Files alone say nothing to judge.
    if item.text.trim().is_empty() {
        return None;
    }
    let prompt = prompt(data, &spec, &item.text);
    let (tx, rx) = mpsc::channel();
    let data = data.to_path_buf();
    // A late answer is dropped with the channel: the run ends by itself.
    thread::spawn(move || {
        let reply = (|| {
            let f = core::fold(&spec.dir, true).ok()?.fold;
            let active = writer::writing(&spec.dir).ok()?;
            active.lock_shared().ok()?;
            commit::written_for(&data, &spec, &f, &active, None, |_| prompt.clone()).ok()
        })();
        let _ = tx.send(reply);
    });
    fits(&rx.recv_timeout(PATIENCE).ok()??)
}

/// Ends `qid`'s Deciding, unless the user acted on it first: one that fits is steered into the
/// open block under the queue's lock, as the row's Steer is, and leaves once the log has it. False
/// while its block only starts, or something else reached it first: nothing went, so it's tried again.
fn settle(data: &Path, id: &str, qid: &str, fits: bool) -> std::io::Result<bool> {
    let dir = core::session_dir(data, id);
    change(&dir, |q| {
        let Some(at) = q.items.iter().position(|i| i.id == qid && i.deciding) else {
            return Ok(true);
        };
        if fits && !q.paused && !q.stopping {
            // A try that failed midway may have gone: nothing goes twice [D54].
            if went(&dir, &Value::Null, qid) {
                q.items.remove(at);
                return Ok(true);
            }
            let (text, parts) = (q.items[at].text.clone(), q.items[at].parts.clone());
            let reply = control::steer_as(data, id, &text, &parts, Some(qid), "user", true)?;
            if went(&dir, &reply, qid) {
                q.items.remove(at);
                return Ok(true);
            }
            if matches!(reply["error"].as_str(), Some("not_running" | "busy")) {
                return Ok(false);
            }
        }
        q.items[at].deciding = false;
        Ok(true)
    })
}

/// What the judge reads for the user's new `message`, as the session is now.
fn prompt(data: &Path, spec: &core::Spec, message: &str) -> String {
    let mut reads = Reads::default();
    let _ = core::read(&spec.dir, |item| reads.push(item));
    let working = (workers::records(data, &spec.id).into_iter())
        .filter(|r| !workers::over(data, &spec.id, &r.wid))
        .map(|r| r.title);
    reads.prompt(&working.collect::<Vec<_>>(), message)
}

/// The judge's answer: whether its last line ending in FITS or WAITS (markdown aside) fits.
fn fits(reply: &str) -> Option<bool> {
    reply.lines().rev().find_map(|line| {
        let word = line.split_whitespace().next_back()?;
        let word = word.trim_matches(|c: char| !c.is_ascii_alphabetic());
        match word {
            "FITS" => Some(true),
            "WAITS" => Some(false),
            _ => None,
        }
    })
}
