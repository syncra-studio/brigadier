//! Deciding, as the old app's [D521]: a message the user queues while a turn runs reads "Deciding"
//! on its row while one small model call judges it: a one-shot of the session's own agent, on its
//! account and its cheapest model, that reads what the running turn works on (`reads`) and the
//! message, and answers FITS or WAITS. The session's turn is never asked.
//!
//! - FITS: it is about that very work, and is steered into the turn, as the user's Steer does.
//!   Where another turn began meanwhile it is judged again, against that one's work, in what is
//!   left of its 5 s.
//! - WAITS, unsure, a late answer or none: it stays queued, no longer Deciding, and goes at the
//!   turn's end, workers or not (the user's, 2026-11-24, over steering in doubt) [D771].
//! - The user moved, edited, steered or deleted it meanwhile: the answer is dropped.
//!
//! Deciding is only a label: the row's actions stay usable and it never holds the queue. A paused
//! queue (after the user's Stop) judges nothing, nor does a session between turns, its block held
//! open or not; another session's message is never judged: it goes in at once [D300].

use super::{Queue, change, read, went};
use crate::{commit, control};
use brigadier_core::{self as core, writer};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

mod reads;
use reads::Reads;

/// How long the judge may take before the message just waits (the old app's 5 s) [D771].
const PATIENCE: Duration = Duration::from_secs(5);

/// How many times, a second apart, a message that fits is tried while its turn only starts, so
/// nothing can be steered into it yet: as long as an agent may take to start one.
const TRIES: u32 = 30;

/// Every message this daemon has judged or is judging: none is judged twice.
static JUDGED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// Whether the user's own message `qid`, added to `q` now, is judged: a turn runs, the queue isn't
/// paused, it isn't there already (a retry), it isn't put back in a slot `at` after an edit, and
/// it doesn't go after a `!` command.
pub(super) fn judges(dir: &Path, q: &Queue, qid: &str, at: Option<usize>) -> bool {
    at.is_none()
        && !q.paused
        && !q.stopping
        && q.running.is_empty()
        && !q.items.iter().any(|i| i.id == qid || i.shell.is_some())
        && core::fold(dir, true).is_ok_and(|f| !f.fold.turns.is_empty())
}

/// The daemon's pass over one session's row: each message newly Deciding is judged off the
/// daemon's loop while a turn runs; where that turn is over by now it just waits its turn.
pub(super) fn pass(data: &Path, id: &str, row: &Value) {
    let items = || row["queue"]["items"].as_array().into_iter().flatten();
    // A turn takes it only from an agent that can be steered.
    let busy = row["running"] == true && row["steer"] == true;
    for qid in items()
        .filter(|i| i["deciding"] == true)
        .filter_map(|i| i["id"].as_str())
    {
        if !JUDGED.lock().unwrap().insert(qid.into()) {
            continue;
        }
        let (data, id, qid) = (data.to_path_buf(), id.to_string(), qid.to_string());
        thread::spawn(move || {
            // One deadline, however often the work it's judged against moves on.
            let until = Instant::now() + PATIENCE;
            let mut verdict = busy.then(|| judge(&data, &id, &qid, until));
            for tried in 0..=TRIES {
                // Out of tries it waits in the queue, no longer Deciding.
                let v = verdict.as_ref().filter(|_| tried < TRIES);
                match settle(&data, &id, &qid, v) {
                    Ok(Settled::Done) => return,
                    Ok(Settled::Moved) => {
                        verdict = Some(judge(&data, &id, &qid, until));
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

/// Whether a message joins the work it was judged against, named by what began it.
struct Verdict {
    fits: bool,
    work: String,
}

/// The judge's verdict on queued `qid`; with no answer by `until` it waits.
fn judge(data: &Path, id: &str, qid: &str, until: Instant) -> Verdict {
    let reads = reads(&core::session_dir(data, id));
    Verdict {
        fits: ask(data, id, qid, &reads, until).unwrap_or(false),
        work: reads.work,
    }
}

/// The judge's answer, none when it gave none by `until`.
fn ask(data: &Path, id: &str, qid: &str, reads: &Reads, until: Instant) -> Option<bool> {
    until.checked_duration_since(Instant::now())?;
    let mut spec = core::load(data, id).ok()?;
    let q = read(&spec.dir).ok()?;
    let item = q.items.into_iter().find(|i| i.id == qid)?;
    // A Stop since the pass, or files alone, which say nothing to judge.
    if q.paused || q.stopping || item.text.trim().is_empty() {
        return None;
    }
    let prompt = reads.prompt(&item.text);
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
            // A Stop while it waited for that.
            if read(&spec.dir).map_or(true, |q| q.paused || q.stopping) {
                return None;
            }
            commit::written_for(&data, &spec, &f, &active, None, |_| prompt.clone()).ok()
        })();
        let _ = tx.send(reply);
    });
    fits(
        &rx.recv_timeout(until.saturating_duration_since(Instant::now()))
            .ok()??,
    )
}

enum Settled {
    Done,
    /// Nothing went: its turn only starts. Tried again.
    Again,
    /// Other work began since it was judged: judged again, against that.
    Moved,
}

/// Ends `qid`'s Deciding, unless the user acted on it first: one that fits is steered into the
/// turn it was judged against, under the queue's lock, as the row's Steer is, and leaves once the
/// log has it. With that turn over it's the drain's.
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
            if core::fold(&dir, true)?.fold.turns.is_empty() {
                q.items[at].deciding = false;
                return Ok(Settled::Done);
            }
            if reads(&dir).work != v.work {
                return Ok(Settled::Moved);
            }
            let (text, parts) = (q.items[at].text.clone(), q.items[at].parts.clone());
            let spec = core::load(data, id)?;
            core::message::take(data, &dir, &parts, None)?;
            let reply = control::steer_turn(data, &spec, &text, &parts, qid, "user")?;
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
