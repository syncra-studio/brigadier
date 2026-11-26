//! A chat's carry-on once its usage limit has reset, outside a night [C34, C54]: the daemon asks
//! here once the row's `reset.due` has passed (the D2028 pattern, no timer), and this command,
//! under the session's fence, checks it all again and sends only if it's still due. A message the
//! user sent meanwhile ended the limit, so nothing is due.

use crate::owner;
use brigadier_core::{self as core, Spec, adapters, fold::Fold, message::Message};
use brigadier_frames::log;
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// The row's `reset`: its carry-on, or why it won't go by itself; none for a worker (routing's
/// hold waits for it, D2028), archived or going, in a night (the night carries on, C17), with the setting off, or at
/// no limit.
pub fn row(data: &Path, spec: &Spec, f: &Fold, worker: bool) -> Option<Value> {
    let off = f.limit.is_none()
        || !f.turns.is_empty()
        || worker
        || core::session::retired(&spec.dir).is_some()
        || core::overnight::load(&spec.dir).night()
        || crate::settings::get(data, "carry_on") != "true";
    if off {
        return None;
    }
    let mut due = core::switch::reset_due(f, |last| {
        let b = last["backend"].as_str().unwrap_or(&spec.backend);
        let (Some(a), Some(id)) = (adapters::get(b), f.resume.get(b)) else {
            return false;
        };
        a.accepted(
            &core::as_run(spec, f, b, None),
            id,
            last["cid"].as_str().unwrap_or(""),
        )
    })?;
    // A try refused (a rule, the project's trust, a level): its words, while it tries each minute.
    let refused: Value = crate::workers::read_json(&spec.dir.join(REFUSED)).unwrap_or_default();
    if due["cid"].is_string() && refused["cid"] == due["cid"] {
        due["error"] = refused["error"].clone();
    }
    Some(due)
}

/// The last carry-on refused, `{cid, error}`, for the row's words.
const REFUSED: &str = "reset.json";

pub fn run(data: &Path, id: &str) -> io::Result<Value> {
    let not_due = json!({"ok": false, "error": "not_due"});
    let spec = core::load(data, id)?;
    owner::ensure(data, &spec)?;
    crate::rewind::settled(data, &spec)?;
    let _fence = core::session::fence(data, &spec)?;
    // The log's length before it's read: a Stop or message landing meanwhile refuses the send.
    let ping = owner::call(data, id, json!({"op": "ping"}))?;
    let Some(len) = ping["len"].as_u64() else {
        return Ok(not_due);
    };
    let f = core::fold(&spec.dir, true)?.fold;
    let worker = crate::workers::link(data, id).is_some();
    let Some(due) = row(data, &spec, &f, worker)
        .filter(|d| d["due"].as_u64().is_some_and(|at| at <= log::now_ms()))
    else {
        return Ok(not_due);
    };
    let cid = due["cid"].as_str().unwrap_or("");
    if f.cids.contains_key(cid) {
        return Ok(not_due);
    }
    let child = (ping["child"].as_i64()).map(|_| ping["spawn"].as_u64().unwrap_or(0));
    let first = std::cell::Cell::new(true);
    // Every write till one lands: an input finding no child leaves the log as it was, so the
    // spawn after it is guarded too.
    let call = |mut req: Value| {
        let writes = matches!(req["op"].as_str(), Some("input" | "spawn"));
        // Turned off meanwhile (a setup's confirm can wait): nothing goes. The log can't say so.
        if writes && crate::settings::get(data, "carry_on") != "true" {
            return Ok(json!({"ok": false, "error": "off", "message": "Carry on was turned off."}));
        }
        let guard = req["if_len"].is_null() && writes && first.get();
        if guard {
            req["if_len"] = len.into();
        }
        let reply = owner::call(data, id, req)?;
        if guard && reply["error"] != "no_child" {
            first.set(false);
        }
        Ok(reply)
    };
    let spec = crate::routing::told(data, &spec);
    let mut reply = core::send(
        &spec,
        &f,
        child,
        &call,
        cid,
        "system",
        &Message::plain(core::switch::LIMIT_RESET),
        due["backend"].as_str().filter(|b| !b.is_empty()),
        due["of"].as_str(),
    );
    let error = reply["message"].as_str().or(reply["error"].as_str());
    match error.filter(|_| reply["ok"] != true && reply["error"] != "changed") {
        Some(e) => core::write_atomic(
            &spec.dir.join(REFUSED),
            json!({"cid": cid, "error": e}).to_string().as_bytes(),
        )?,
        None => _ = std::fs::remove_file(spec.dir.join(REFUSED)),
    }
    reply["recovered"] = "reset".into();
    Ok(reply)
}
