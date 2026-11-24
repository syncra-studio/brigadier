//! Another session's messages in the queue [D2034], kept apart from the user's own, and
//! Brigadier's own send-back, which never waits there [D529].

use super::{Item, change, read};
use crate::owner;
use brigadier_core as core;
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
        let known = q.items.iter().any(|i| i.id == mid)
            || q.editing.as_ref().is_some_and(|e| e.id == mid)
            || core::fold(dir, true)?.fold.cids.contains_key(mid);
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
        });
        q.paused |= q.stopping;
        Ok("queued")
    })
}

/// Whether `mid` waits in the queue, or is being edited there.
pub fn pending(dir: &Path, mid: &str) -> bool {
    read(dir).is_ok_and(|q| {
        q.items.iter().any(|i| i.id == mid) || q.editing.as_ref().is_some_and(|e| e.id == mid)
    })
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
