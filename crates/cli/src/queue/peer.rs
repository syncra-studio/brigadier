//! Another session's messages in the queue [D2034], kept apart from the user's own.

use super::{Item, change, read};
use brigadier_core as core;
use serde_json::Value;
use std::io;
use std::path::Path;

/// Another session's message [D2034]: under the queue's lock, a repeat of its id (queued, being
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
