//! Rebirth on its own [D88, D108]: the daemon asks here for a session whose running turn passed
//! its threshold with no tool running, or whose window refused its last turn. A running turn is
//! stopped first; then the fresh conversation starts from the hand-off alone, in the same session.
//! A rebirth at a turn's end waits for the next input, which `core::send` carries. A model or
//! agent picked mid-turn cuts it the same way, and the new one carries on from there [D124].
//! A turn the loop guard holds is stopped with no rebirth, till the user's Continue [D144].

use crate::{owner, workers};
use brigadier_core::{self as core, message::Message};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// The user's Continue on a turn the guard stopped: the guard starts over and it carries on.
pub fn go_on(data: &Path, id: &str) -> io::Result<Value> {
    let spec = core::load(data, id)?;
    owner::ensure(data, &spec)?;
    let f = core::fold(&spec.dir, true)?.fold;
    let Some(turn) = f.last.as_ref().filter(|_| core::rebirth::stalled(&f)) else {
        return Ok(json!({"ok": false, "error": "not_due"}));
    };
    owner::call(
        data,
        id,
        json!({"op": "note", "data": {"event": "go_on", "turn": turn["id"]}}),
    )?;
    run(data, id)
}

pub fn run(data: &Path, id: &str) -> io::Result<Value> {
    let not_due = json!({"ok": false, "error": "not_due"});
    let spec = core::load(data, id)?;
    owner::ensure(data, &spec)?;
    // Its input lost to a crash before any CLI read it: sent again, as a rebirth [D54].
    let f = core::fold(&spec.dir, true)?.fold;
    if f.turns
        .first()
        .is_some_and(|t| t.switch["why"] == "cut" && t.delivered.is_none())
    {
        return crate::queue::recover(data, id, false);
    }
    crate::rewind::settled(data, &spec)?;
    let _fence = core::session::fence(data, &spec)?;
    let f = core::fold(&spec.dir, true)?.fold;
    let Some(why) = core::rebirth::due(&spec, &f) else {
        return Ok(not_due);
    };
    if why == "stall" {
        if crate::control::interrupt(data, id, "stall")?.is_none() {
            owner::call(data, id, json!({"op": "stop", "by": "stall"}))?;
        }
        return Ok(json!({"ok": true, "result": "stalled"}));
    }
    if let Some(t) = f.turns.first() {
        // Logged before the stop, so its end is known as this one's, never the user's Stop.
        let cut = json!({"op": "note", "data": {"event": "rebirth_cut", "turn": t.id, "switch": why == "switch"}});
        owner::call(data, id, cut)?;
        if crate::control::interrupt(data, id, "rebirth")?.is_none() {
            // Its CLI can't end a turn and stay: its processes stop instead.
            owner::call(data, id, json!({"op": "stop", "by": "rebirth"}))?;
        }
    }
    let ping = owner::call(data, id, json!({"op": "ping"}))?;
    let Some(len) = ping["len"].as_u64() else {
        return Ok(not_due);
    };
    let f = core::fold(&spec.dir, true)?.fold;
    let Some(last) = f.last.as_ref().filter(|_| f.turns.is_empty()) else {
        return Ok(not_due);
    };
    let Some(why) = core::rebirth::due(&spec, &f) else {
        return Ok(not_due);
    };
    // One per turn it carries on: a repeat or a racing pass finds its id logged [D54].
    let cid = format!("rb-{}", last["id"].as_str().unwrap_or(""));
    // A worker's cut turn would have reported to its parent: the fresh one does instead, so a
    // second cut can't leave the first reading as finished.
    let turn = last["id"].as_str().unwrap_or("");
    if let Some(mut l) = workers::link(data, id).filter(|l| l.report.iter().any(|r| r == turn)) {
        l.report.retain(|r| r != turn);
        l.report.push(cid.clone());
        workers::write_json(&spec.dir.join("worker.json"), &l)?;
    }
    let child = (ping["child"].as_i64()).map(|_| ping["spawn"].as_u64().unwrap_or(0));
    // The first write only: a new setup the same agent confirms first moves the log itself.
    let first = std::cell::Cell::new(true);
    let call = |mut req: Value| {
        let writes = matches!(req["op"].as_str(), Some("input" | "spawn"));
        if req["if_len"].is_null() && writes && first.replace(false) {
            req["if_len"] = len.into();
        }
        owner::call(data, id, req)
    };
    // Another agent picked carries on from the hand-off; another model of this one, in the same
    // conversation, told why it stopped [D110, D124].
    let msg = match why == "switch" && f.picked.is_none() {
        true => Message::plain(core::switch::SWITCHED),
        false => Message::plain(""),
    };
    Ok(core::send(
        &crate::routing::told(data, &spec),
        &f,
        child,
        &call,
        &cid,
        "system",
        &msg,
        None,
        None,
    ))
}
