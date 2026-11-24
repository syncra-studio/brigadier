//! Deciding, as the old app's [D521]: a message the user queues while the session's block works
//! reads "Deciding" on its row while one small model call judges it: a one-shot of the session's
//! own agent, on its account and its cheapest model, that reads what the session is at (`reads`) and
//! the message, and answers FITS or WAITS. The session's turn is never asked.
//!
//! - FITS, a late answer or none: it is steered into the open block, as the user's Steer does.
//!   When unsure it steers (proposed; the old app waited) [D771]. Where another block began
//!   meanwhile it is judged again, and only FITS joins that one.
//! - WAITS: it stays queued, no longer Deciding, for its own turn.
//! - The user moved, edited, steered or deleted it meanwhile: the answer is dropped.
//!
//! Deciding is only a label: the row's actions stay usable and it never holds the queue. A paused
//! queue (after the user's Stop) judges nothing, and another session's message is never judged:
//! it goes in at once [D300].

use super::{DRAINS, Queue, change, read, went};
use crate::{commit, control, owner, workers};
use brigadier_core::{self as core, fold, writer};
use brigadier_frames::procs;
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

/// How many times, a second apart, a message that fits is tried while its block only starts or is
/// between turns, so nothing can be steered into it yet: as long as an agent may take to start one.
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
        && (items().find(|i| i["to"].is_null())).is_none_or(|i| i["error"].is_null());
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
            let mut verdict = busy.then(|| judge(&data, &id, &qid, true));
            for tried in 0..=TRIES {
                // Out of tries it waits in the queue, no longer Deciding.
                let v = verdict.as_ref().filter(|_| tried < TRIES);
                match settle(&data, &id, &qid, v) {
                    Ok(Settled::Done) => return,
                    Ok(Settled::Moved) => {
                        verdict = Some(judge(&data, &id, &qid, false));
                        continue;
                    }
                    Ok(Settled::Again) => {}
                    Err(e) => eprintln!("brigadierd: judge {id}: {e}"),
                }
                thread::sleep(Duration::from_secs(1));
            }
        });
    }
}

/// Whether a message joins the block it was judged against, named by the turn that began it.
struct Verdict {
    fits: bool,
    block: String,
}

/// The judge's verdict on queued `qid`; with no answer in time, `unsaid`: it fits the block it was
/// written in, not one that began since.
fn judge(data: &Path, id: &str, qid: &str, unsaid: bool) -> Verdict {
    let dir = core::session_dir(data, id);
    let reads = reads(&dir);
    let fits = ask(data, id, qid, &reads).unwrap_or(unsaid);
    Verdict {
        fits,
        block: reads.block,
    }
}

/// The judge's answer, none when it gave none in time.
fn ask(data: &Path, id: &str, qid: &str, reads: &Reads) -> Option<bool> {
    let mut spec = core::load(data, id).ok()?;
    let q = read(&spec.dir).ok()?;
    let item = q.items.into_iter().find(|i| i.id == qid)?;
    // A Stop since the pass, or files alone, which say nothing to judge.
    if q.paused || q.stopping || item.text.trim().is_empty() {
        return None;
    }
    let working = (workers::records(data, &spec.id).into_iter())
        .filter(|r| !workers::over(data, &spec.id, &r.wid))
        .map(|r| r.title);
    let prompt = reads.prompt(&working.collect::<Vec<_>>(), &item.text);
    // It loads none of the user's servers, skills or hooks, and no tool may run.
    spec.naked = true;
    spec.opts.insert("no_tools".into(), "1".into());
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

enum Settled {
    Done,
    /// Nothing went: its block only starts or is between turns. Tried again.
    Again,
    /// Other work began since it was judged: judged again, against that.
    Moved,
}

/// Ends `qid`'s Deciding, unless the user acted on it first: one that fits is steered into the
/// block it was judged against, under the queue's lock, as the row's Steer is, and leaves once the
/// log has it. With that block over it's the drain's, if the session can take it at all.
fn settle(data: &Path, id: &str, qid: &str, verdict: Option<&Verdict>) -> std::io::Result<Settled> {
    let dir = core::session_dir(data, id);
    change(&dir, |q| {
        let Some(at) = q.items.iter().position(|i| i.id == qid && i.deciding) else {
            return Ok(Settled::Done);
        };
        if let Some(v) = verdict.filter(|v| v.fits && !q.paused && !q.stopping) {
            // A try that failed midway may have gone: nothing goes twice [D54].
            if went(&dir, &Value::Null, qid) {
                q.items.remove(at);
                return Ok(Settled::Done);
            }
            if reads(&dir).block != v.block {
                return Ok(Settled::Moved);
            }
            let (text, parts) = (q.items[at].text.clone(), q.items[at].parts.clone());
            let f = core::fold(&dir, true)?.fold;
            let reply = if f.turns.is_empty() {
                // Between turns, where the drain wouldn't send it neither does this: a limit, a
                // sign-in or a cut-off run needs the user.
                let live = fold::live(&f, owner::state(data, id), &dir, &procs::all());
                let status = fold::status(&f, &live);
                if !DRAINS.contains(&status["state"].as_str().unwrap_or("")) {
                    q.items[at].deciding = false;
                    return Ok(Settled::Done);
                }
                // Over, the block takes nothing: it's the drain's, unless one starts first.
                if !workers::holding(data, id) {
                    return Ok(Settled::Again);
                }
                control::steer_as(data, id, &text, &parts, Some(qid), "user", true)?
            } else {
                let spec = core::load(data, id)?;
                core::message::take(data, &dir, &parts, None)?;
                control::steer_turn(data, &spec, &text, &parts, qid, "user")?
            };
            if went(&dir, &reply, qid) {
                q.items.remove(at);
                return Ok(Settled::Done);
            }
            if matches!(reply["error"].as_str(), Some("not_running" | "busy")) {
                return Ok(Settled::Again);
            }
        }
        q.items[at].deciding = false;
        Ok(Settled::Done)
    })
}

/// What the judge reads of the session, as it is now, what a rewind dropped left out.
fn reads(dir: &Path) -> Reads {
    let mut reads = Reads::default();
    let _ = core::rewind::read_active(dir, |item| reads.push(item));
    reads
}

/// The judge's answer: whether its last line that is FITS or WAITS, or ends in that word after a
/// sentence, fits; the word inside a sentence ("don't conclude WAITS") is none.
fn fits(reply: &str) -> Option<bool> {
    reply.lines().rev().find_map(|line| {
        let mut words = line.split_whitespace().rev();
        let bare = |w: &str| {
            w.trim_matches(|c: char| !c.is_ascii_alphabetic())
                .to_string()
        };
        let mut word = bare(words.next()?);
        match words.next() {
            None => word.make_ascii_uppercase(),
            Some(before) if before.ends_with(['.', '!', '?', ';', ':', ')', '-', '—', '→']) => {
            }
            Some(_) => return None,
        }
        match word.as_str() {
            "FITS" => Some(true),
            "WAITS" => Some(false),
            _ => None,
        }
    })
}
