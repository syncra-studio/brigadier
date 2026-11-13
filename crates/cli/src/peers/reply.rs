//! A sender's wait for its answer: the turn that took its message, or, for a worker's question to
//! its own parent [D119, D131], its parent's answer. That question goes to its parent's wait or
//! wake, never its user's queue.

use super::{COUNTING, In, Out, all, note, path, refuse, send};
use crate::workers;
use brigadier_core::{self as core};
use serde_json::{Value, json};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

/// A worker's question's states: its send waits, it stopped waiting, its parent answered.
pub(super) const ASKS: [&str; 3] = ["asking", "asked", "answered"];

/// A worker's question to its parent: written for the parent as its other asks are, so its wait or
/// its wake gets it [D131], then waited on. The answer is the send's reply and the worker's quiet
/// "‹parent› answered" step [D121, D122]; one that comes after the wait goes as a message.
pub(super) fn ask(
    data: &Path,
    me: &str,
    out: &mut Out,
    secs: u64,
    here: &dyn Fn() -> bool,
) -> Value {
    let to = out.to.clone();
    out.state = "asking".into();
    let p = path(data, me, "out", &out.mid);
    if let Err(e) =
        workers::write_json(&p, out).and_then(|()| workers::question(data, me, &out.mid, &out.text))
    {
        return refuse(&format!("Couldn't send it: {e}"));
    }
    let started = Instant::now();
    loop {
        let reply = |o: Option<Out>| o.and_then(|o| o.reply);
        let mut answer = reply(workers::read_json(&p));
        if answer.is_none() && (started.elapsed() >= Duration::from_secs(secs) || !here()) {
            // Under the lock its answer takes, so one that comes later knows to go as a message.
            let _one = COUNTING.lock().unwrap_or_else(|e| e.into_inner());
            answer = reply(workers::read_json(&p));
            if answer.is_none() {
                out.state = "asked".into();
                let _ = workers::write_json(&p, out);
                let text = format!(
                    "No answer from {to} after {secs}s. It comes to you as a message when it answers: go on with what you can, or end your turn."
                );
                return json!({"ok": true, "mid": out.mid, "done": false, "text": text});
            }
        }
        if let Some(reply) = answer {
            let text = format!("{to} answered:\n{}", reply.trim_end());
            return json!({"ok": true, "mid": out.mid, "done": true, "reply": reply, "text": text});
        }
        thread::sleep(Duration::from_millis(500));
    }
}

/// The id of the open question worker `wid` asks its parent.
pub(crate) fn question(data: &Path, wid: &str) -> Option<String> {
    let parent = workers::link(data, wid)?.parent;
    let mut open: Vec<Out> = (all::<Out>(data, wid, "out").into_iter())
        .filter(|o| o.to == parent && matches!(o.state.as_str(), "asking" | "asked"))
        .collect();
    open.sort_by_key(|o| o.at);
    open.pop().map(|o| o.mid)
}

/// The parent's answer to its worker's question `mid`: back to the send that waits, or, with none
/// waiting any more, as a message from the parent. The worker's step shows it [D121, D122].
pub(crate) fn answer(data: &Path, parent: &str, wid: &str, mid: &str, text: &str) -> Value {
    let one = COUNTING.lock().unwrap_or_else(|e| e.into_inner());
    let p = path(data, wid, "out", mid);
    let Some(mut out) = workers::read_json::<Out>(&p) else {
        return refuse(&format!("{wid} isn't waiting on you."));
    };
    let waits = out.state == "asking";
    (out.state, out.reply) = ("answered".into(), Some(text.into()));
    if let Err(e) = workers::write_json(&p, &out) {
        return refuse(&e.to_string());
    }
    drop(one);
    note(
        data,
        wid,
        json!({"phase": "answered", "mid": mid, "reply": text}),
    );
    if !waits {
        return send(data, parent, &json!({"id": wid}), text, None, &|| true);
    }
    json!({"ok": true, "text": format!("Sent to {wid}.")})
}

/// `--wait`: until the receiver's turn that took the message ends, then its last message, or for
/// one's own worker that turn's result, taken so it isn't sent again [D3006, D3034]. Proposed:
/// the turn's last message is the reply. Always times out [D2034].
pub(super) fn waited(
    data: &Path,
    me: &str,
    out: &Out,
    secs: u64,
    here: &dyn Fn() -> bool,
) -> Value {
    let started = Instant::now();
    let to = out.to.as_str();
    let dir = core::session_dir(data, to);
    loop {
        let rec: Option<In> = workers::read_json(&path(data, to, "in", &out.mid));
        let Some(rec) = rec.filter(|_| dir.exists()) else {
            return refuse(&format!("{to} is gone."));
        };
        if rec.state == "dropped" {
            return refuse(&format!("{to}'s user took your message out of its queue."));
        }
        let turn = rec.turn.clone().unwrap_or_else(|| out.mid.clone());
        let ended = core::fold(&dir, true).is_ok_and(|f| {
            f.fold.cids.contains_key(&out.mid) && !f.fold.turns.iter().any(|t| t.id == turn)
        });
        if ended {
            let mine = workers::take(data, me, to, Some(&turn));
            let reply = mine.or_else(|| workers::last_of_turn(data, to, &turn));
            let reply = reply.unwrap_or_default();
            note(data, me, json!({"phase": "replied", "mid": out.mid}));
            let text = format!("{to} answered:\n{}", reply.trim_end());
            return json!({"ok": true, "mid": out.mid, "done": true, "reply": reply, "text": text});
        }
        if started.elapsed() >= Duration::from_secs(secs) || !here() {
            note(data, me, json!({"phase": "waited", "mid": out.mid}));
            let text = format!(
                "No reply from {to} after {secs}s. Your message is with it. `brigadier wait {to}` to wait more, or end your turn."
            );
            return json!({"ok": true, "mid": out.mid, "done": false, "text": text});
        }
        thread::sleep(Duration::from_millis(500));
    }
}
