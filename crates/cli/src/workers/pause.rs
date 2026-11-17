//! The user's Pause and Resume of a worker, as the old app's pauseTask and resumeTask [D199,
//! D3041, D3042]. Pause ends its turn as Stop does, holds what is sent to it, and reports nothing
//! to its parent until Resume; Resume sends what was held, then "Continue where you stopped.",
//! whose turn reports back as its brief's did. The parent's thread reads "Paused ‹name›" and
//! "Resumed ‹name›".

use super::{busy, family_lock, halt, link, make, note, place, record, refuse, write_json};
use brigadier_core::{self as core};
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

const CONTINUE: &str = "Continue where you stopped.";

/// `workers <id> pause|resume <wid>`, for the user, on a worker below `top`.
pub(super) fn run(data: &Path, top: &str, how: &str, wid: &str) -> Value {
    if !super::below(data, top).iter().any(|r| r.wid == wid) {
        return refuse(&format!("{wid} isn't a worker of {top}"));
    }
    let started = Instant::now();
    while make::making(&[wid.to_string()]) && started.elapsed() < Duration::from_secs(30) {
        std::thread::sleep(Duration::from_millis(100));
    }
    let Some(l) = link(data, wid) else {
        return refuse("the worker hasn't started yet");
    };
    if record(data, &l.parent, wid).is_some_and(|r| r.state == "starting") {
        return refuse("the worker hasn't started yet");
    }
    let reply = match how {
        "pause" => pause(data, top, wid),
        _ => resume(data, wid),
    };
    if reply["ok"] == true {
        note(
            data,
            &l.parent,
            json!({"event": "worker", "phase": format!("{how}d"), "ids": [wid]}),
        );
    }
    reply
}

fn pause(data: &Path, top: &str, wid: &str) -> Value {
    let dir = core::session_dir(data, wid);
    let mark = |paused: bool| -> io::Result<Value> {
        let (root, _) = place(data, wid);
        let _family = family_lock(data, &root)?;
        let mut l = link(data, wid).ok_or_else(|| io::Error::other("the worker has ended"))?;
        l.paused = paused;
        write_json(&dir.join("worker.json"), &l)?;
        Ok(l.last)
    };
    {
        let (root, _) = place(data, wid);
        let Ok(_family) = family_lock(data, &root) else {
            return refuse("Couldn't pause the worker");
        };
        let Some(l) = link(data, wid) else {
            return refuse("the worker has ended");
        };
        if l.paused {
            return json!({"ok": true});
        }
        // Its reported task, or a turn the user started in it.
        if !busy(data, wid) && !crate::sessions::working(data, wid, &procs::all()) {
            return refuse("the worker isn't running");
        }
    }
    // Marked before its turn ends, so the stopped turn writes no result.
    let before = match mark(true) {
        Ok(last) => last,
        Err(e) => return refuse(&e.to_string()),
    };
    if let Err(e) = halt(data, top, wid, "pause") {
        let _ = mark(false);
        return refuse(&e.to_string());
    }
    // Its task ended by itself before the Pause took: its result goes as ever, nothing is paused.
    let _ = super::result::write_ended(data, wid, false);
    if link(data, wid).is_some_and(|l| l.last != before) {
        let _ = mark(false);
        return refuse("the worker finished before it could pause");
    }
    json!({"ok": true})
}

/// Queues the continue after what was held, then lets the queue go, the stopped turn not carried
/// on first: the continue is the one turn [D3049]. It stays paused when the continue can't be
/// queued.
fn resume(data: &Path, wid: &str) -> Value {
    let (root, _) = place(data, wid);
    let Ok(_family) = family_lock(data, &root) else {
        return refuse("Couldn't resume the worker");
    };
    let Some(mut l) = link(data, wid).filter(|l| l.paused) else {
        return json!({"ok": true});
    };
    let dir = core::session_dir(data, wid);
    if let Err(e) = crate::queue::give_held(data, &l.parent, wid) {
        return refuse(&e.to_string());
    }
    let cid = crate::control::new_cid();
    let add = ["queue", wid, "add", CONTINUE, "--qid", &cid].map(String::from);
    if let Err(e) = crate::run(data, &add) {
        return refuse(&e.to_string());
    }
    // Only the continue reports back, once what was held went before it: one result at the end.
    // A mockup worker not yet picked reports nothing till Use [D560].
    l.report = match l.asked["mockup"].is_null() || !l.report.is_empty() {
        true => vec![cid],
        false => vec![],
    };
    (l.paused, l.last) = (false, Value::Null);
    if let Err(e) = write_json(&dir.join("worker.json"), &l) {
        return refuse(&e.to_string());
    }
    match crate::queue::release(&dir) {
        Ok(()) => json!({"ok": true}),
        Err(e) => refuse(&e.to_string()),
    }
}

/// While paused, its queue reads paused, so the daemon sends it nothing.
pub fn held(dir: &Path, mut queue: Value) -> Value {
    let paused =
        super::read_json::<super::Link>(&dir.join("worker.json")).is_some_and(|l| l.paused);
    if paused && queue.is_object() {
        queue["paused"] = true.into();
    }
    queue
}
