//! The daemon's pass over a sender's open messages: each finished, or settled by its receiver's log.

use super::{DONE, In, OPEN, Out, all, held, path, reply, save, settle_out};
use crate::{owner, queue, workers};
use brigadier_core::{self as core, fold::Fold};
use brigadier_frames::{procs, take_lock};
use std::collections::BTreeMap;
use std::io;
use std::path::Path;

/// Finishes and settles a sender's open messages; with none left, it leaves the set.
pub(super) fn finish(data: &Path, from: &str, states: &BTreeMap<String, String>) -> io::Result<()> {
    let mut open = false;
    for out in all::<Out>(data, from, "out") {
        let Some(mut out) = held::current(data, from, out) else {
            open = true;
            continue;
        };
        // A Recover that died before it reopened this one left its link in the receiver's log:
        // that link settles it, as the Recover would have [D66].
        if out.state == "uncertain" && relinked(data, &out.to, &out.mid) {
            held::reopen(data, &out.to, &serde_json::json!([out.mid]));
            let Some(now) = workers::read_json(&path(data, from, "out", &out.mid)) else {
                continue;
            };
            out = now;
        }
        // A worker's question is its parent's to settle, by its answer.
        if DONE.contains(&out.state.as_str()) || reply::ASKS.contains(&out.state.as_str()) {
            continue;
        }
        open = true;
        let to = out.to.clone();
        let dir = core::session_dir(data, &to);
        let at = path(data, &to, "in", &out.mid);
        let mut rec: Option<In> = workers::read_json(&at);
        if core::load(data, &to).is_err() {
            settle_out(data, from, &mut out, "dropped", Some("deleted"));
            continue;
        }
        // What comes of a steer is saved under its receiver's queue lock: held, it's still on its way.
        if rec.as_ref().is_some_and(|r| r.state == "steering") {
            let Some(_lock) = take_lock(&dir.join("queue.lock"))? else {
                continue;
            };
            rec = workers::read_json(&at);
        }
        // Cut short before its receiver had it, or while it was being queued: once now, under
        // the receiver's lock, which drops a repeat.
        let cut = match &rec {
            None => true,
            Some(r) => {
                matches!(r.state.as_str(), "adding" | "held")
                    || (r.state == "steering"
                        && !core::fold(&dir, true)?.fold.cids.contains_key(&out.mid))
            }
        };
        if cut {
            reply::again(data, from, &mut out, rec.is_none())?;
            continue;
        }
        let Some(mut rec) = rec else { continue };
        let f = core::fold(&dir, true)?.fold;
        let state = states.get(&to).map_or("", String::as_str);
        let settled = if f.cids.contains_key(&out.mid) {
            match rec.state.as_str() {
                "steering" => proof(data, &to, &f, &out.mid),
                "delivered" | "uncertain" => Some(rec.state.as_str()),
                _ => workers::settled(&f, &out.mid, state),
            }
        } else if queue::pending(&dir, &out.mid) {
            None
        } else if rec.state == "queued" {
            Some("dropped")
        } else {
            None
        };
        let Some(settled) = settled.map(String::from) else {
            continue;
        };
        if rec.state != settled {
            rec.state = settled.clone();
            save(data, &to, "in", &out.mid, &rec)?;
        }
        let why = match settled.as_str() {
            "dropped" => Some("removed from its queue"),
            // In its agent's own words.
            "refused" => (f.replies.get(last(&f, &out.mid))).and_then(|r| r["error"].as_str()),
            _ => None,
        };
        settle_out(data, from, &mut out, &settled, why);
    }
    // Read again under its lock: one opened since this pass read them stays open [D66].
    let mut set = OPEN.lock().unwrap();
    let settled =
        |o: &Out| DONE.contains(&o.state.as_str()) || reply::ASKS.contains(&o.state.as_str());
    if !open && all::<Out>(data, from, "out").iter().all(settled) {
        set.as_mut().map(|o| o.remove(from));
    }
    Ok(())
}

/// Whether a Recover logged where `mid` went, and that settles it or may yet: taken, resent, or
/// given back with its recovery.
fn relinked(data: &Path, to: &str, mid: &str) -> bool {
    let Ok(f) = core::fold(&core::session_dir(data, to), true) else {
        return false;
    };
    f.fold.replies.contains_key(mid) && proof(data, to, &f.fold, mid) != Some("uncertain")
}

/// What the receiver's agent said of a steer written to it [D66]: it took it, refused it, or took
/// the recovery that gave it back; none yet while the process it went to may still reply. With
/// none to come, it stays uncertain.
fn proof(data: &Path, to: &str, f: &Fold, mid: &str) -> Option<&'static str> {
    let target = last(f, mid);
    let went_to = f.acking.get(target).map(|i| &i["child"]);
    // Its own process still, under the host that runs now: a host that died leaves its child in
    // the log, never able to reply through the one started since [D66].
    let host = owner::pid(data, to);
    let alive = (f.child.as_ref()).is_some_and(|c| {
        !c.exited
            && went_to.is_none_or(|w| w.is_null() || w == c.start_us)
            && procs::same(c.pid, c.start_us).is_some_and(|p| Some(p.ppid) == host)
    });
    match f.replies.get(target) {
        Some(r) if r["error"].is_null() => Some("delivered"),
        // The agent's own refusal.
        Some(r) if r["how"].is_null() => Some("refused"),
        _ if alive && f.acking.contains_key(target) => None,
        _ => Some("uncertain"),
    }
}

/// Each Recover that sent `mid` again names the next: the last one's word is its own.
fn last<'a>(f: &'a Fold, mid: &'a str) -> &'a str {
    let mut target = mid;
    for _ in 0..16 {
        let next = f.replies.get(target).filter(|r| r["how"] == "resent");
        let Some(next) = next.and_then(|r| r["as"].as_str()) else {
            break;
        };
        target = next;
    }
    target
}
