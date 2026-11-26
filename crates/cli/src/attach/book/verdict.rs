//! What came of a command that took a message, by one rule [D54, C58]: it went once its id is in
//! the queue's items or the log; it's given back only on the word of the command that holds its
//! lock (`draft-<cid>.lock`): a queue add that finds nothing once it ran, or a send's own definite
//! refusal on a first attempt. Anything else stays unsettled in the book.

use super::unsent::is_unsent;
use brigadier_core as core;
use serde_json::{Value, json};
use std::io;
use std::path::Path;

#[derive(Clone, Copy, PartialEq)]
pub(super) enum How {
    Went,
    Refused,
    Unknown,
}

/// Whether message `cid` is in session `dir`: waiting in its queue, else in its log. The queue
/// first: a drain drops an item only once the log has it, so a read between the two still finds
/// it. Never the edit slot: an edited item added again keeps its id, so the old one there proves
/// nothing of the new; a lost edit stays unsettled, with Try again [C67].
pub(super) fn present(dir: &Path, cid: &str) -> bool {
    let q = crate::queue::row(dir);
    let mut items = q["items"].as_array().into_iter().flatten();
    items.any(|i| i["id"] == cid)
        || core::fold(dir, true).is_ok_and(|f| f.fold.cids.contains_key(cid))
}

/// The same, in the lock a drain sends under, so none is midway: for a caller holding no
/// draft.lock, which is never taken inside it [§5.2].
pub(super) fn there(dir: &Path, cid: &str) -> bool {
    let _held = crate::queue::hold(dir).ok();
    present(dir, cid)
}

/// What came of `out`, an attempt at message `cid` by the command holding its lock and no
/// draft.lock. `first`: no earlier attempt may have reached a host. A host can refuse before it
/// checks the ids it took, and an earlier request may still be waiting at it, so only a first
/// attempt's refusal proves the message never went [D66].
pub(super) fn verdict(
    dir: &Path,
    queue: bool,
    cid: &str,
    first: bool,
    out: &io::Result<Value>,
) -> How {
    if out.as_ref().is_ok_and(|r| r["ok"] == true) {
        return How::Went;
    }
    match out {
        _ if there(dir, cid) => How::Went,
        // Its own add ran and left nothing: the queue's one writer for this id says so.
        _ if queue => How::Refused,
        _ if !first => How::Unknown,
        Ok(r) if r["answered"] == false => How::Unknown,
        Ok(_) => How::Refused,
        Err(e) if is_unsent(e) => How::Refused,
        Err(_) => How::Unknown,
    }
}

/// The command's reply saying what came of it: `logged` where that's known, else `unsettled`, the
/// book keeping it for Try again under the same id.
pub(super) fn answer(out: io::Result<Value>, how: How) -> Value {
    let mut reply = out.unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}));
    if reply["ok"] != true {
        match how {
            How::Unknown => reply["unsettled"] = true.into(),
            how => reply["logged"] = (how == How::Went).into(),
        }
    }
    reply
}
