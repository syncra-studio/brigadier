//! A worker's result [D3006]: when a task it reports back on ends, Rust writes how it ended, its
//! last message, its branch and commits, then delivers it into the parent once, on the delivery
//! rules [D54, D82, D237]: written first in the parent's `results/`, sent under its own id with the
//! parent between turns and its queue empty, done once the parent's log proves the agent took it.
//! Logged without that proof, it's uncertain and never sent again by itself. An idle parent wakes;
//! a busy one gets it after its turn. Turns the user starts in a worker report nothing.

mod deliver;
mod images;
mod report;
mod take;
pub(super) mod told;
mod unsent;

use super::review;
use super::{Link, Record, link, read_json};
use brigadier_core::fold;
use brigadier_core::{self as core};
use brigadier_frames::log;
pub use deliver::deliver;
pub(crate) use deliver::settled;
pub(super) use report::{Of, write, write_as};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
pub use take::{going, hop, reported, take, take_ask, told, unrun, went_with, with_next};
pub use told::{notice as told_notice, shell as told_shell, take as told_take, take_shell};

/// The most of its last message a result carries [D3006].
const LAST: usize = 16 << 10;

/// How long a turn that ended with background work still running waits for that work to wake it
/// before it reports as it ended; a wake later than this reports by itself (`unsaid`). shortcut:
/// work left running for good (a dev server) holds the result this long; upgrade if it shows.
const WAKE_MS: u64 = 10 * 60_000;

#[derive(Serialize, Deserialize, Clone, Default)]
pub(super) struct Res {
    /// Its command id in the parent.
    pub id: String,
    pub wid: String,
    /// The worker's turn it reports, by its stable id; for `asks`, its request's id.
    pub turn: String,
    /// finished | failed | refused (by its provider's safety checks) | context | limit | stopped |
    /// asks (a request for the parent, `asks`)
    pub how: String,
    pub text: String,
    pub at: u64,
    /// written | sent (logged in the parent) | delivered | uncertain | held (stopped, till a turn
    /// of the parent's ends or its next message; `ended` by the user or its parent, till that message [D330, D328]) |
    /// taken (by the parent's own `wait` or its next message) | dropped (its family is deleted) |
    /// review (a reviewer the switch started: its findings go to its worker instead [D3026])
    pub state: String,
    #[serde(default)]
    pub ended: bool,
    /// The hop of the turn it reports, so a parent it wakes carries the chain on [D2034].
    #[serde(default)]
    pub hop: u64,
    /// `merged=<base>` or `unmerged=<base>` for a worker with commits of its own; else empty.
    #[serde(default)]
    pub merge: String,
    /// A `quiet` one's parent input it went with: taken once the parent's log has it (`told`).
    #[serde(default)]
    pub going: String,
    /// When the turn, or the wake that carried it on, ended that it reports (ms); the most for one
    /// its host's death ended, 0 for one no turn ended for or an older build's.
    #[serde(default)]
    pub end: u64,
    /// Why its parent refused it last, said once in the parent's thread till it goes [C26].
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub refused: String,
}

/// Parents with a result not yet settled; filled from disk at the daemon's first pass.
static OPEN: Mutex<Option<BTreeSet<String>>> = Mutex::new(None);
/// Each worker's end last looked at, so a pass folds only one that changed.
static SEEN: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);

pub(super) fn dir_of(data: &Path, pid: &str) -> PathBuf {
    core::session_dir(data, pid).join("results")
}

pub(super) fn path_of(data: &Path, pid: &str, wid: &str, turn: &str) -> PathBuf {
    dir_of(data, pid).join(format!("{wid}.{turn}.json"))
}

pub(super) fn all(data: &Path, pid: &str) -> Vec<(PathBuf, Res)> {
    let mut all: Vec<(PathBuf, Res)> = (fs::read_dir(dir_of(data, pid)).into_iter().flatten())
        .flatten()
        .filter_map(|e| read_json(&e.path()).map(|r| (e.path(), r)))
        .collect();
    all.sort_by_key(|(_, r)| (r.at, r.end));
    all
}

/// Parents with results on disk, read once at the daemon's first use.
fn known(data: &Path) -> BTreeSet<String> {
    let ids = core::ids(data).into_iter();
    ids.filter(|id| dir_of(data, id).exists()).collect()
}

pub(super) fn open(data: &Path, pid: &str) {
    let mut open = OPEN.lock().unwrap();
    open.get_or_insert_with(|| known(data)).insert(pid.into());
}

/// After a pass's rows: a worker whose reported turn ended gets its result written. Only a worker
/// whose turns changed is folded.
pub(super) fn written(data: &Path, wid: &str, row: &Value) {
    images::pass(data, wid, row);
    told::scan(data, wid, row);
    if row["running"] == true {
        return;
    }
    // Its log's length too: a turn cut off again leaves both others as the last cut did.
    let at = json!([row["finished"], row["state"], row["items"]]);
    {
        let mut seen = SEEN.lock().unwrap();
        if seen
            .get_or_insert_with(HashMap::new)
            .insert(wid.into(), at.clone())
            == Some(at)
        {
            return;
        }
    }
    // One waiting on its background work is looked at again each pass, so its wait can run out.
    if write_ended(data, wid, row["state"] == "interrupted").unwrap_or(false) {
        SEEN.lock().unwrap().as_mut().map(|s| s.remove(wid));
    }
}

/// Writes the result of each reported turn of `wid` that ended and has none yet. `cut`: its host
/// died, so a turn it left open ended too, failed. Says whether one waits on its background work.
pub(super) fn write_ended(data: &Path, wid: &str, cut: bool) -> io::Result<bool> {
    let Some(mut l) = link(data, wid) else {
        return Ok(false);
    };
    let f = core::fold(&core::session_dir(data, wid), true)?.fold;
    let mut waits = false;
    let reports = reported(&l, &f);
    // A turn the user started in it reports too, quietly, on the same rules [D303].
    let direct = told::turns(&f).into_iter().filter(|t| !reports.contains(t));
    let turns: Vec<_> = (reports.iter().map(|t| (t.clone(), false)))
        .chain(direct.map(|t| (t, true)))
        .collect();
    for (turn, direct) in &turns {
        let open = f.turns.iter().any(|t| &t.id == turn);
        let ended = f.cids.contains_key(turn) && (!open || cut);
        if !ended {
            continue;
        }
        for (end, late) in unsaid(data, &l, wid, &f, turn, *direct, cut) {
            let own = f.last.as_ref().filter(|last| last["id"] == turn.as_str());
            let last = f.last.as_ref().filter(|last| last["id"] == end.id.as_str());
            let newest = end.at == u64::MAX || f.end(turn).is_none_or(|e| e.at == end.at);
            // A turn cut for a rebirth, or one its full window refused, goes on in a fresh
            // conversation, whose own end reports instead [D88, D108], unless it ended done first.
            // So does one the network cut, which Brigadier resumes by itself [D339].
            // Not one whose renewal the user's Stop or Pause called off in or after its summary
            // turn, at a limit too: only they drop a renewal before it starts (D95).
            let off = (f.last.as_ref())
                .filter(|l| l["origin"] == "summary" && f.renewing.is_none() && f.turns.is_empty());
            let on = f.cut.as_deref() == Some(turn)
                && !last.is_some_and(|l| l["outcome"] == "done")
                && off.is_none();
            if (newest && on)
                || last.is_some_and(|l| l["why"] == "context" && core::rebirth::again_last(&f, l))
                || last.is_some_and(|_| core::fold::reconnect(&f, false).is_some())
            {
                break;
            }
            // Brigadier's own stop isn't the user's: it reports, and wakes the parent, as any end.
            // A fold cached before ends kept who stopped them has it only on its last end.
            let by = (end.by.clone()).or_else(|| {
                let reason = last.and_then(|l| l["reason"].as_str().map(String::from));
                reason.filter(|_| end.how == "stopped")
            });
            // A cut whose renewal was called off reads as the Stop or Pause that did it.
            let by = match off.filter(|_| f.cut.as_deref() == Some(turn)) {
                Some(l) if l["reason"] == "pause" => Some("pause".into()),
                Some(_) => Some("user".into()),
                None => by,
            };
            let how = match (end.how.as_str(), by.as_deref()) {
                ("done", _) => "finished",
                ("stopped", Some("stall")) => "context",
                ("stopped", None | Some("user" | "agent" | "pause" | "rewind")) => "stopped",
                ("stopped", _) => "failed",
                ("limited", _) => "limit",
                _ if last.is_some_and(|l| l["why"] == "context") => "context",
                ("failed", _) if end.why.as_deref() == Some("blocked") => "refused",
                _ => "failed",
            };
            // A late wake's end reports at once, whatever else still runs.
            if !cut && !late && newest && holds(&f, turn) {
                waits = true;
                break;
            }
            // A paused one's stopped task reports nothing: Resume's continue does [D3041]. One that
            // ended by itself before the Pause took reports as ever; one a later wake hid, as stopped.
            // A routed worker's limit isn't its end: it moves within its row or holds [D2041, D2028].
            // A reviewer and a fix turn end at their limit [D3026].
            let moves = how == "limit" && !l.ran["label"].is_null() && review::moves(&l);
            if (l.paused && (how == "stopped" || own.is_none())) || moves {
                break;
            }
            let of = report::Of {
                direct: *direct,
                end: end.at,
                late,
                // Its own last word, or its wake's, never one that came after this end.
                said: (end.at > 0).then_some((end.id, end.at)),
                by,
            };
            let how = match late || *direct {
                true => Some(how),
                false if l.review["of"].is_string() => {
                    review::after(data, &l, wid, turn, how, None, of);
                    continue;
                }
                false => review::holds(data, &mut l, wid, turn, how, &f),
            };
            let Some(how) = how else { break };
            if late && !direct && how == "finished" {
                review::ran(data, &l, wid, turn, of.end);
            }
            report::write_as(data, &l, wid, turn, how, None, of)?;
        }
    }
    Ok(waits)
}

/// The ends of `turn` still to report, oldest first, each with whether it's `late`: a wake's that
/// came after the turn's result was written, which reports too, once, in a result of its own named
/// by when it ended. The most for one its host died in (`cut`).
pub(super) fn unsaid(
    data: &Path,
    l: &Link,
    wid: &str,
    f: &fold::Fold,
    turn: &str,
    direct: bool,
    cut: bool,
) -> Vec<(fold::End, bool)> {
    let mut ends = f.ends.get(turn).cloned().unwrap_or_default();
    // Its host died in it, or in the wake that carried it on: that was cut, and so was it.
    if cut && (woken(f, turn) || f.turns.iter().any(|t| t.id == turn)) {
        ends.push(fold::End {
            at: u64::MAX,
            how: "cut".into(),
            id: ends.last().map_or(turn.into(), |e| e.id.clone()),
            began: f.turns.first().map_or(0, |t| t.ts),
            ..Default::default()
        });
    }
    // An input no turn of its own ended for, as one that joined another's.
    if ends.is_empty() {
        ends.push(fold::End {
            how: "done".into(),
            id: turn.into(),
            ..Default::default()
        });
    }
    let path = |key: &str| path_of(data, &l.parent, wid, key);
    let told = |end: u64| path(&format!("{turn}.{end}")).exists();
    let once = !direct && (l.review["of"].is_string() || l.review["plan"].is_string());
    let since = match path(turn).exists() {
        false => {
            // Its first result is of the end no wake carried on within the hold.
            let over = |w: &[fold::End]| w[1].began.saturating_sub(w[0].at) >= WAKE_MS;
            let first = ends.windows(2).position(over).unwrap_or(ends.len() - 1);
            ends.drain(..first);
            if once {
                review::once(data, l, wid, turn, &mut ends);
            }
            return (ends.into_iter().enumerate())
                .map(|(i, e)| (e, i > 0))
                .collect();
        }
        true if told(u64::MAX) => return vec![],
        true => read_json::<Res>(&path(turn)),
    };
    let Some(r) = since else { return vec![] };
    if once {
        // An older build's, whose result doesn't name its end, stays over.
        if r.end == 0 || (r.how == "finished" && review::found(&r.text)) {
            return vec![];
        }
        ends.retain(|e| e.at >= r.end);
        review::once(data, l, wid, turn, &mut ends);
    }
    let late = |e: &fold::End| match r.end {
        // shortcut: an older build's result doesn't name its end, and a wake long before the
        // upgrade isn't news; one is told if the daemon sees it this soon.
        0 => e.at > r.at && log::now_ms().saturating_sub(e.at) < WAKE_MS,
        end => e.at > end,
    };
    (ends.into_iter())
        .filter(|e| late(e) && !told(e.at))
        .map(|e| (e, true))
        .collect()
}

/// Whether its CLI carries `turn` on now, in a wake of its own.
fn woken(f: &fold::Fold, turn: &str) -> bool {
    f.turns
        .first()
        .is_some_and(|t| t.origin == "agent" && t.of == turn)
}

/// Whether `turn`, ended, waits on its live CLI's background work: it goes on in the wake that
/// work started, whose end reports it, or, ended done, in the one its work still running will
/// start, for up to WAKE_MS after it or its last wake ended, so work that never wakes it can't
/// hold it [D118].
pub(super) fn holds(f: &fold::Fold, turn: &str) -> bool {
    if f.child.as_ref().is_none_or(|c| c.exited) {
        return false;
    }
    let (since, done) = f.end(turn).map_or((0, true), |e| (e.at, e.how == "done"));
    let soon = log::now_ms().saturating_sub(since) < WAKE_MS;
    woken(f, turn) || (done && soon && wakes(f))
}

/// Whether background work its live CLI still runs will wake it.
pub(super) fn wakes(f: &fold::Fold) -> bool {
    f.child.as_ref().is_some_and(|c| !c.exited) && (f.pending.wakes() || !f.agents.is_empty())
}

/// A start that failed before its worker could run: its result says why.
pub(super) fn failed(data: &Path, pid: &str, r: &Record) {
    let l = Link {
        parent: pid.into(),
        title: r.title.clone(),
        ran: json!({"agent": r.backend, "model": r.model, "effort": r.effort}),
        review: r.review.clone(),
        ..Default::default()
    };
    let error = r.error.as_deref();
    match l.review["of"].is_string() {
        true => review::after(data, &l, &r.wid, &r.cid, "failed", error, Of::default()),
        false => drop(write(data, &l, &r.wid, &r.cid, "failed", error)),
    }
}

/// Whether a result still has something to say: a worker's ask only while it waits.
pub(super) fn fresh(data: &Path, r: &Res) -> bool {
    r.how != "asks" || super::asks::waits(data, &r.wid, &r.turn)
}
