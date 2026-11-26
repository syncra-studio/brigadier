//! What came of a command that took a message: whether it went, and its reply saying so [D54].

use super::unsent::is_unsent;
use super::{How, logged, queued};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// Whether message `cid` went, by the reply `out` of the command that took it.
pub(super) fn how(dir: &Path, kind: &str, cid: &str, out: &io::Result<Value>) -> How {
    // Refused, unless an earlier try under its id got in: the queue first, as in replay.
    let went = || match queued(dir, cid) || logged(dir, cid) {
        true => How::Went,
        false => How::Refused,
    };
    match out {
        Ok(r) if r["ok"] == true => How::Went,
        _ if kind == "queue" => went(),
        // A hand-off refused took nothing: its message never went.
        _ if kind == "chips" => How::Refused,
        Ok(r) if r["answered"] == false => How::Unknown,
        Ok(_) => went(),
        // This try never reached a host.
        Err(e) if is_unsent(e) => went(),
        Err(_) => How::Unknown,
    }
}

/// The command's reply with `logged`, where it's known.
pub(super) fn answer(out: io::Result<Value>, how: How) -> io::Result<Value> {
    let mut reply = match out {
        Ok(reply) => reply,
        // Known either way, it says so; an earlier try may have got in.
        Err(e) if how != How::Unknown => json!({"ok": false, "error": e.to_string()}),
        Err(e) => return Err(e),
    };
    if reply["ok"] != true && how != How::Unknown {
        reply["logged"] = (how == How::Went).into();
    }
    Ok(reply)
}
