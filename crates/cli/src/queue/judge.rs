//! Deciding, as the old app's [D521, D39]: a message the user queues while the session's block is
//! open (a turn runs, or workers or subagents hold it) reads "Deciding" on its row while one small
//! model call judges it: a one-shot of the session's own agent, on its account and its cheapest
//! model, that reads what the block works on (`reads`) and the message, and answers FITS or WAITS.
//! The session's turn is never asked.
//!
//! - FITS: it is about that very work, and is steered into the turn, as the user's Steer does; in
//!   a block held open it's the drain's next turn. Where another turn began meanwhile it is judged
//!   again, against that one's work, in what is left of its 10 s.
//! - WAITS, unsure, a late answer or none: it stays queued, no longer Deciding, its row saying why,
//!   and goes when `Queue::goes` says, never judged again [D771].
//! - The user moved, edited, steered or deleted it meanwhile: the answer is dropped.
//!
//! The row's actions stay usable meanwhile. In a held block it holds the drain, so nothing skips
//! it; in a turn it holds nothing. A paused queue (after the user's Stop) judges nothing, nor does a
//! session with no block open; another session's message is never judged: it goes in at once [D300].
//! What was decided, why and on what is kept in the session's folder (`record`).

use super::{Item, Queue, change, cut, read, went};
use crate::{commit, control, workers};
use brigadier_core::{self as core, writer};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

mod reads;
mod record;
use reads::Reads;

/// How long the judge may take before the message just waits (repo-merge D49).
const PATIENCE: Duration = Duration::from_secs(10);

/// How many times, a second apart, a message that fits is tried while its turn only starts, so
/// nothing can be steered into it yet: as long as an agent may take to start one.
const TRIES: u32 = 30;

/// The messages this daemon is deciding: none twice at once.
static JUDGED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// Whether the user's own message `qid`, added to `q` now, is judged: its block is open, the queue
/// isn't paused, it isn't there already (a retry), it isn't put back in a slot `at` after an edit, and
/// it doesn't go after a `!` command.
pub(super) fn judges(data: &Path, id: &str, q: &Queue, qid: &str, at: Option<usize>) -> bool {
    at.is_none()
        && !q.paused
        && !q.stopping
        && q.running.is_empty()
        && !q.items.iter().any(|i| i.id == qid || i.shell.is_some())
        && (core::fold(&core::session_dir(data, id), true).is_ok_and(|f| !f.fold.turns.is_empty())
            || workers::holding(data, id))
}

/// The daemon's pass over one session's row: each message newly Deciding is judged off the
/// daemon's loop while its block is open; where that is over by now it just waits its turn.
pub(super) fn pass(data: &Path, id: &str, row: &Value) {
    // A turn takes it only from an agent that can be steered.
    let steer = row["steer"] == true;
    let items = row["queue"]["items"].as_array().into_iter().flatten();
    for i in items.filter(|i| i["deciding"] == true) {
        let Some(qid) = i["id"].as_str().map(String::from) else {
            continue;
        };
        if !JUDGED.lock().unwrap().insert(qid.clone()) {
            continue;
        }
        let (data, id) = (data.to_path_buf(), id.to_string());
        thread::spawn(move || {
            decide(&data, &id, &qid, steer);
            JUDGED.lock().unwrap().remove(&qid);
        });
    }
}

/// Judges queued `qid` and settles it. One it couldn't settle is still Deciding, which a held block
/// waits for: the next pass tries again.
fn decide(data: &Path, id: &str, qid: &str, steer: bool) {
    let q = read(&core::session_dir(data, id)).unwrap_or_default();
    // Settled since the row was made.
    let Some(item) = q.items.iter().find(|i| i.id == qid && i.deciding) else {
        return;
    };
    // One deadline, however often the work it's judged against moves on.
    let until = Instant::now() + PATIENCE;
    let mut verdict = open(data, id, steer).then(|| judge(data, id, qid, until));
    for tried in 0..=TRIES {
        // Out of tries it waits in the queue, no longer Deciding.
        let v = verdict.as_ref().filter(|_| tried < TRIES);
        match settle(data, id, qid, v) {
            Ok(Settled::Done(then)) => return record::keep(data, id, item, verdict.as_ref(), then),
            Ok(Settled::Moved) => {
                record::keep(data, id, item, verdict.as_ref(), "other work began");
                verdict = Some(judge(data, id, qid, until));
                continue;
            }
            Ok(Settled::Again) => {}
            Err(e) => eprintln!("brigadierd: judge {id}: {e}"),
        }
        thread::sleep(Duration::from_secs(1));
    }
}

/// Whether its block is open now: a turn that can be steered, or one held open.
fn open(data: &Path, id: &str, steer: bool) -> bool {
    let runs = cut::now(data, id).is_ok_and(|(f, state)| {
        let summary = f.turns.first().is_some_and(|t| t.origin == "summary");
        steer
            && !f.turns.is_empty()
            && !summary
            && !matches!(state.as_str(), "interrupted" | "undelivered")
    });
    runs || workers::holding(data, id)
}

/// What the judge made of a message.
struct Verdict {
    fits: bool,
    /// Why it waits, as its queue item says.
    waits: Option<&'static str>,
    /// The work it was judged against, named by what began it, and the workers it goes on in.
    work: String,
    working: Vec<String>,
    /// The judge's first line and model, or why there is no answer.
    said: String,
    model: Option<String>,
    error: String,
    /// When it was asked, and how long it took.
    asked: u64,
    took: Duration,
}

/// The judge's verdict on queued `qid`; with no answer by `until` it waits.
fn judge(data: &Path, id: &str, qid: &str, until: Instant) -> Verdict {
    let (asked, from) = (brigadier_frames::log::now_ms(), Instant::now());
    let dir = core::session_dir(data, id);
    let mut reads = reads(&dir);
    if core::fold(&dir, true).is_ok_and(|f| f.fold.turns.is_empty()) {
        let works = |w: &str| {
            !workers::over(data, id, w) && !workers::link(data, w).is_some_and(|l| l.paused)
        };
        reads.working = (workers::records(data, id).into_iter())
            .filter(|r| works(&r.wid))
            .map(|r| r.title)
            .collect();
    }
    let answer = ask(data, id, qid, &reads, until);
    let mut v = Verdict {
        fits: false,
        waits: None,
        work: reads.work,
        working: reads.working,
        said: String::new(),
        model: None,
        error: String::new(),
        asked,
        took: from.elapsed(),
    };
    match answer {
        Ok((reply, model)) => {
            (v.said, v.model) = (reply.trim().lines().next().unwrap_or("").into(), model);
            match fits(&reply) {
                Some(true) => v.fits = true,
                Some(false) => v.waits = Some("judged"),
                None => (v.waits, v.error) = (Some("failed"), "it answered neither word".into()),
            }
        }
        Err(No::Unasked) => v.error = "not asked: stopped, or no words to judge".into(),
        Err(No::Late) => (v.waits, v.error) = (Some("late"), "no answer in time".into()),
        Err(No::Failed(why)) => (v.waits, v.error) = (Some("failed"), why),
    }
    v
}

/// Why there is no answer.
enum No {
    Unasked,
    Late,
    Failed(String),
}

/// The judge's reply by `until`, and its model.
fn ask(
    data: &Path,
    id: &str,
    qid: &str,
    reads: &Reads,
    until: Instant,
) -> Result<(String, Option<String>), No> {
    until
        .checked_duration_since(Instant::now())
        .ok_or(No::Late)?;
    let failed = |e: std::io::Error| No::Failed(e.to_string());
    let mut spec = core::load(data, id).map_err(failed)?;
    let q = read(&spec.dir).map_err(failed)?;
    let item = q.items.into_iter().find(|i| i.id == qid && i.deciding);
    // A Stop since the pass, or files alone, which say nothing to judge.
    let item = item
        .filter(|i| !q.paused && !q.stopping && !i.text.trim().is_empty())
        .ok_or(No::Unasked)?;
    let prompt = reads.prompt(&item.text);
    // It loads none of the user's servers, skills or hooks, and no tool may run.
    spec.naked = true;
    spec.opts.insert("no_tools".into(), "1".into());
    let (tx, rx) = mpsc::channel();
    let data = data.to_path_buf();
    // A late answer is dropped with the channel: the run ends by itself.
    thread::spawn(move || {
        let reply = (|| {
            let f = core::fold(&spec.dir, true).map_err(failed)?.fold;
            let active = writer::writing(&spec.dir).map_err(failed)?;
            active.lock_shared().map_err(failed)?;
            // A Stop while it waited for that.
            if read(&spec.dir).map_or(true, |q| q.paused || q.stopping) {
                return Err(No::Unasked);
            }
            commit::written_for(&data, &spec, &f, &active, None, |_| prompt.clone())
                .map_err(No::Failed)
        })();
        let _ = tx.send(reply);
    });
    rx.recv_timeout(until.saturating_duration_since(Instant::now()))
        .unwrap_or(Err(No::Late))
}

enum Settled {
    /// And what became of it.
    Done(&'static str),
    /// Nothing went yet: its turn only starts, or the drain sends it next. Tried again.
    Again,
    /// Other work began since it was judged: judged again, against that.
    Moved,
}

/// Ends `qid`'s Deciding, unless the user acted on it first: one that fits is steered into the
/// turn it was judged against, under the queue's lock, as the row's Steer is, and leaves once the
/// log has it; in a block held open the drain sends it. With that block over it's the drain's.
fn settle(data: &Path, id: &str, qid: &str, verdict: Option<&Verdict>) -> std::io::Result<Settled> {
    let dir = core::session_dir(data, id);
    change(&dir, |q| {
        let (paused, at) = (q.paused || q.stopping, |i: &&mut Item| {
            i.id == qid && i.deciding
        });
        let Some(item) = q.items.iter_mut().find(at) else {
            return Ok(Settled::Done(match went(&dir, &Value::Null, qid) {
                true => "sent",
                false => "the user moved, edited or deleted it",
            }));
        };
        let fits = verdict.filter(|v| v.fits && !paused && item.error.is_none());
        if let Some(v) = fits {
            // A try that failed midway may have gone: nothing goes twice [D54].
            if went(&dir, &Value::Null, qid) {
                q.items.retain(|i| i.id != qid);
                return Ok(Settled::Done("sent"));
            }
            let held = core::fold(&dir, true)?.fold.turns.is_empty();
            if held && !workers::holding(data, id) {
                (item.deciding, item.fits) = (false, false);
                return Ok(Settled::Done("its work is over: goes next"));
            }
            let moved = reads(&dir).work != v.work;
            item.fits = held && !moved;
            if moved {
                return Ok(Settled::Moved);
            }
            if held {
                return Ok(Settled::Again);
            }
            let (text, parts) = (item.text.clone(), item.parts.clone());
            let spec = core::load(data, id)?;
            core::message::take(data, &dir, &parts, None)?;
            let reply = control::steer_turn(data, &spec, &text, &parts, qid, "user")?;
            if went(&dir, &reply, qid) {
                q.items.retain(|i| i.id != qid);
                return Ok(Settled::Done("steered"));
            }
            if matches!(reply["error"].as_str(), Some("not_running" | "busy")) {
                return Ok(Settled::Again);
            }
        }
        (item.deciding, item.fits) = (false, false);
        item.waits = verdict.and_then(|v| v.waits).map(String::from);
        Ok(Settled::Done("waits"))
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
