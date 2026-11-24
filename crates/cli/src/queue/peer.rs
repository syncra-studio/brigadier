//! Another session's messages in the queue [D2034], kept apart from the user's own, and
//! Brigadier's own send-back, which never waits there [D529].

use super::{Item, change, cut, read};
use crate::{owner, workers};
use brigadier_core::{self as core, adapters};
use brigadier_frames::take_lock;
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// Another session's message [D2034] or a system notice: under the queue's lock, a repeat of its id (queued, being
/// edited or in the log) is dropped; else `first` records it and may take it itself (a steer, or
/// held for the running turn), saying how; else it goes last, as its sender's. Says which happened.
pub fn add_peer(
    dir: &Path,
    mid: &str,
    origin: &str,
    text: &str,
    first: impl FnOnce() -> io::Result<Option<&'static str>>,
) -> io::Result<&'static str> {
    change(dir, |q| {
        let f = core::fold(dir, true)?.fold;
        let known = q.items.iter().any(|i| i.id == mid)
            || q.editing.as_ref().is_some_and(|e| e.id == mid)
            || f.cids.contains_key(mid);
        if known {
            return Ok("repeat");
        }
        if let Some(how) = first()? {
            return Ok(how);
        }
        q.items.push(Item {
            id: mid.into(),
            text: text.into(),
            parts: Value::Null,
            at: brigadier_frames::log::now_ms(),
            error: None,
            origin: Some(origin.into()),
            to: None,
            deciding: false,
            shell: None,
        });
        // A cut-off worker stopped since waits for Resume.
        q.paused |= q.stopping || (cut::stopped(&f) && cut::parents(dir, Some(origin)));
        Ok("queued")
    })
}

/// Whether `mid` waits in the queue, or is being edited there.
pub fn pending(dir: &Path, mid: &str) -> bool {
    read(dir).is_ok_and(|q| {
        q.items.iter().any(|i| i.id == mid) || q.editing.as_ref().is_some_and(|e| e.id == mid)
    })
}

/// What a sender's agent reads of a message its receiver's agent didn't confirm (proposed words).
pub const UNSURE: &str =
    "Its agent didn't confirm it, so it may not have it: it isn't sent again by itself.";

/// What `from`'s message `mid` to `id`, handed over and not steered, waits for, as its sender's
/// agent reads it (proposed words). `held`: for the running turn.
pub fn waits_for(data: &Path, from: &str, id: &str, mid: &str, held: bool) -> String {
    let dir = core::session_dir(data, id);
    let q = read(&dir).unwrap_or_default();
    let (f, state) = cut::now(data, id).unwrap_or_default();
    let at = q.items.iter().position(|i| i.id == mid);
    if !held && at.is_none() && f.cids.contains_key(mid) {
        return match state.as_str() {
            "uncertain" | "undelivered" => UNSURE.into(),
            _ => "It started its next turn.".into(),
        };
    }
    let link = cut::link(&dir);
    let origin = format!("peer:{from}");
    let carries = state == "interrupted" && cut::carries(&dir, &f, Some(&origin));
    let holding = workers::holding(data, id);
    // What goes before it: past a cut-off run only its parent's do.
    let goes = |i: &&Item| {
        i.to.is_none()
            && (!holding || i.origin.is_some())
            && (!carries || cut::parents(&dir, i.origin.as_deref()))
    };
    let ahead = q.items.iter().take(at.unwrap_or(0)).find(goes);
    let after = |i: &Item| match i.error {
        Some(_) => "a message before it couldn't be sent, so it waits for its user to settle that",
        None => "it goes after the messages sent to it before",
    };
    let steers = adapters::get(&f.backend).is_some_and(|a| a.can().steer);
    let why = match state.as_str() {
        _ if !held && (q.paused || link.as_ref().is_some_and(|l| l.paused)) => {
            "it was stopped or paused, so it waits for its user to press Resume"
        }
        "interrupted" if carries => match ahead {
            None => return "It was cut off mid-turn: your message carries it on.".into(),
            Some(i) => after(i),
        },
        "interrupted" if link.as_ref().is_some_and(|l| !l.session) && !cut::begun(&f) => {
            "it was cut off before its conversation began, so it waits for its user to message it"
        }
        "interrupted" if link.is_some_and(|l| !l.session) => {
            "it was cut off mid-turn, so it waits for its user, or a message from the session that started it, to carry it on"
        }
        "interrupted" => "it was cut off mid-turn, so it waits for its user to carry it on",
        "undelivered" | "uncertain" => {
            "its last message may not have reached its agent, so it waits for its user to settle that"
        }
        "limited" => "it's at its usage limit, so it waits until it can go on past that",
        "out_of_credits" => "it's out of credits, so it waits until it can go on past that",
        "sign_in" => "its agent is signed out, so it waits for its user to sign in",
        "unresumable" => {
            "its agent can't resume its conversation, so it waits for its user to move it on"
        }
        "unresponsive" => "its host isn't answering, so it waits until it does",
        "waiting_answer" if held => "it's waiting on its user, so it waits for their answer",
        "waiting_answer" => "it hasn't started and needs its user's answer first",
        "asking" => "it's waiting on the session that started it, so it waits for that answer",
        "reconnecting" => {
            "its connection dropped, so it waits for it to come back and its turn to end"
        }
        "new" => "it goes once its first turn ends",
        _ if held && steers => {
            return "It goes into the turn it's working on as soon as that turn can take it."
                .into();
        }
        _ if held || !f.turns.is_empty() => "it gets it when its turn ends",
        _ => match ahead {
            None => return "It's queued and starts its next turn.".into(),
            Some(i) => after(i),
        },
    };
    format!("It's queued: {why}.")
}

/// Brigadier's send-back of turn `turn`'s reply, as its own words [D529]: sent at once under the
/// queue's lock, only while that turn is still the session's last and nothing waits to go, and
/// only if nothing reached its log since. Never queued, so a refusal leaves nothing behind.
pub fn send_back(data: &Path, id: &str, turn: &str, text: &str) -> io::Result<bool> {
    let dir = core::session_dir(data, id);
    // The send that started the turn may hold it a moment longer than a quick turn lasts.
    let mut lock = None;
    for _ in 0..30 {
        lock = take_lock(&dir.join("queue.lock"))?;
        if lock.is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if lock.is_none() {
        return Ok(false);
    }
    let ping = owner::call(data, id, json!({"op": "ping"}))?;
    let Some(len) = ping["len"].as_u64() else {
        return Ok(false);
    };
    let f = core::fold(&dir, true)?.fold;
    let last = f.last.as_ref().filter(|_| f.turns.is_empty());
    if !last.is_some_and(|l| l["id"] == turn) || read(&dir).is_ok_and(|q| !q.items.is_empty()) {
        return Ok(false);
    }
    let spec = crate::routing::told(data, &core::load(data, id)?);
    let child = (ping["child"].as_i64()).map(|_| ping["spawn"].as_u64().unwrap_or(0));
    let call = |mut req: Value| {
        if req["if_len"].is_null() && matches!(req["op"].as_str(), Some("input" | "spawn")) {
            req["if_len"] = len.into();
        }
        owner::call(data, id, req)
    };
    let msg = core::message::Message::plain(text);
    let cid = format!("{turn}.sb");
    let reply = core::send(&spec, &f, child, &call, &cid, "system", &msg, None, None);
    Ok(reply["ok"] == true)
}
