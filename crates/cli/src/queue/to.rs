//! The user's message for one of the session's own workers (the composer's To chip), as the old
//! app's: sent while that worker works, it waits in this session's queue, "To ‹name›" on its row,
//! and goes to that worker alone as its next turn once it's between turns, never to this session.
//! A paused worker holds it until Resume [D3006, D3041, D3050].

use super::{DRAINS, Item, Queue, change, locked, read, went};
use crate::{control, owner};
use brigadier_core::{self as core, fold};
use brigadier_frames::{procs, take_lock};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io;
use std::path::Path;
use std::thread;

/// `--to <wid>` must be one of `id`'s own workers.
pub(super) fn check(data: &Path, id: &str, wid: &str) -> io::Result<()> {
    match crate::workers::link(data, wid) {
        Some(l) if l.parent == id => Ok(()),
        _ => Err(io::Error::other(format!("{wid} isn't a worker of {id}"))),
    }
}

/// The first message waiting for `wid`, which goes before its others.
pub(super) fn first(q: &Queue, wid: &str) -> Option<String> {
    let first = q.items.iter().find(|i| i.to.as_deref() == Some(wid));
    first.map(|i| i.id.clone())
}

/// Whether the user or its parent ended it: nothing goes to it any more.
fn ended(l: &crate::workers::Link) -> bool {
    !l.paused && l.last["how"] == "stopped"
}

/// Whether worker `wid` takes a message now: between turns, not paused or ended, nothing of its
/// own waiting.
fn free(data: &Path, wid: &str) -> bool {
    let dir = core::session_dir(data, wid);
    let open = crate::workers::link(data, wid).is_some_and(|l| !l.paused && !ended(&l));
    let idle = read(&dir).is_ok_and(|w| w.items.is_empty() && w.editing.is_none() && !w.paused);
    open && idle
        && core::fold(&dir, true).is_ok_and(|f| {
            let live = fold::live(&f.fold, owner::state(data, wid), data, &procs::all());
            DRAINS.contains(&fold::status(&f.fold, &live)["state"].as_str().unwrap_or(""))
        })
}

/// Gives queued `qid` to its worker: free, into the worker's own queue, which sends it next;
/// else a Steer goes into its running turn. It leaves this queue once the worker has it. Paused,
/// even a Steer waits for Resume. A steer's reply, if it went as one.
pub(super) fn give(
    data: &Path,
    id: &str,
    q: &mut Queue,
    qid: &str,
    steer: bool,
) -> io::Result<Option<Value>> {
    let Some(at) = q.items.iter().position(|i| i.id == qid) else {
        return Ok(None);
    };
    let Some(wid) = q.items[at].to.clone() else {
        return Ok(None);
    };
    let free = free(data, &wid);
    if !(free || steer && crate::workers::link(data, &wid).is_some_and(|l| !l.paused)) {
        return Ok(None);
    }
    if free {
        return hand(data, id, q, at).map(|()| None);
    }
    let item = q.items[at].clone();
    let dir = core::session_dir(data, &wid);
    core::message::take(data, &dir, &item.parts, Some(id))?;
    let reply = control::steer_as(data, &wid, &item.text, &item.parts, Some(qid), "user")?;
    if went(&dir, &reply, qid) {
        q.items.remove(at);
    }
    Ok(Some(reply))
}

/// Moves queued item `at` into its worker's own queue, last, as the user's; once there, it leaves
/// this one.
fn hand(data: &Path, id: &str, q: &mut Queue, at: usize) -> io::Result<()> {
    let item = q.items[at].clone();
    let dir = core::session_dir(data, item.to.as_deref().unwrap_or_default());
    core::message::take(data, &dir, &item.parts, Some(id))?;
    change(&dir, |w| {
        if !w.items.iter().any(|i| i.id == item.id) {
            let at = brigadier_frames::log::now_ms();
            w.items.push(Item {
                to: None,
                error: None,
                at,
                ..item
            });
        }
        Ok(())
    })?;
    q.items.remove(at);
    Ok(())
}

/// A paused worker's Resume: what the user sent it meanwhile goes into its queue first, in order,
/// so it goes before its "Continue where you stopped.", as the old app's [D3041].
pub fn held(data: &Path, pid: &str, wid: &str) -> io::Result<()> {
    change(&core::session_dir(data, pid), |q| {
        while let Some(at) = q.items.iter().position(|i| i.to.as_deref() == Some(wid)) {
            hand(data, pid, q, at)?;
        }
        Ok(())
    })
}

/// The daemon's pass: a session whose queue holds a message for a worker now between turns gives
/// it, off the daemon's loop.
pub(super) fn pass(data: &Path, rows: &BTreeMap<String, Value>) {
    // An ended one's messages are looked at too, to say so on their row [D96].
    let ready = |w: &Value| {
        w["worker"]["kind"] == "stopped"
            || w["queue"].is_null()
                && w["worker"]["kind"] != "paused"
                && DRAINS.contains(&w["state"].as_str().unwrap_or(""))
    };
    for (id, row) in rows {
        let items = row["queue"]["items"].as_array().into_iter().flatten();
        let waits = |i: &Value| {
            i["error"].is_null()
                && i["to"]
                    .as_str()
                    .and_then(|w| rows.get(w))
                    .is_some_and(ready)
        };
        if !items.into_iter().any(waits) {
            continue;
        }
        let (data, id) = (data.to_path_buf(), id.clone());
        thread::spawn(move || {
            if let Err(e) = give_firsts(&data, &id) {
                eprintln!("brigadierd: queue {id}: {e}");
            }
        });
    }
}

/// Each worker's first message, under the queue's lock (another pass that finds it held leaves
/// it); one that can't go says why and waits there, as each for a worker that ended does [D96].
fn give_firsts(data: &Path, id: &str) -> io::Result<()> {
    let dir = core::session_dir(data, id);
    let Some(_lock) = take_lock(&dir.join("queue.lock"))? else {
        return Ok(());
    };
    locked(&dir, |q| {
        let mut wids: Vec<String> = q.items.iter().filter_map(|i| i.to.clone()).collect();
        wids.sort();
        wids.dedup();
        for wid in wids {
            if let Some(l) = crate::workers::link(data, &wid).filter(ended) {
                (q.items.iter_mut())
                    .filter(|i| i.to.as_deref() == Some(wid.as_str()) && i.error.is_none())
                    .for_each(|i| i.error = Some(format!("{} has ended", l.title)));
                continue;
            }
            let Some(qid) =
                first(q, &wid).filter(|f| q.items.iter().any(|i| &i.id == f && i.error.is_none()))
            else {
                continue;
            };
            if let Err(e) = give(data, id, q, &qid, false)
                && let Some(i) = q.items.iter_mut().find(|i| i.id == qid)
            {
                i.error = Some(e.to_string());
            }
        }
        Ok(())
    })
}
