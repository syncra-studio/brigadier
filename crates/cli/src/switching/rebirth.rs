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
    // A summary turn past its minutes is stopped; its renewal goes ahead without it [rev 3 §4].
    if why == "late" {
        if crate::control::interrupt(data, id, "summary")?.is_none() {
            owner::call(data, id, json!({"op": "stop", "by": "summary"}))?;
        }
        return Ok(json!({"ok": true, "result": "late"}));
    }
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
        let done = |f: &core::fold::Fold| {
            f.turns.is_empty()
                && f.last
                    .as_ref()
                    .is_some_and(|l| l["id"] == t.id.as_str() && l["outcome"] == "done")
        };
        // A turn that ended on its own first is left be: it rebirths at the next message [D108].
        if crate::control::interrupt(data, id, "rebirth")?.is_none()
            && !done(&core::fold(&spec.dir, true)?.fold)
        {
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
    // A turn ended done past its line, or one this cut stopped, first writes its summary in the
    // old conversation, once per renewal [D92; rev 3 §2.2].
    // Another agent picked and Switch now: its summary too; another model of this one, none.
    let cut = f.cut.as_deref() == last["id"].as_str() && last["outcome"] != "done";
    let other = (f.picked.as_ref()).is_some_and(|p| p.backend != core::rebirth::backend(&spec, &f));
    let fresh = cut && f.renewing.is_none() && core::summary::applies(&spec, &f);
    let summary = match why {
        "summary" => Some("rebirth"),
        "cut" if fresh => Some("cut"),
        "switch" if fresh && other => Some("switch"),
        _ => None,
    };
    // The turn the renewal serves, past its summary turn.
    let served = core::summary::served(&f).unwrap_or_else(|| last.clone());
    // One per turn it carries on: a repeat or a racing pass finds its id logged [D54].
    let cid = match summary {
        Some(_) => format!("sm-{}", last["id"].as_str().unwrap_or("")),
        None => format!("rb-{}", served["id"].as_str().unwrap_or("")),
    };
    // A worker's cut turn would have reported to its parent: the fresh one does instead, so a
    // second cut can't leave the first reading as finished.
    let turn = served["id"].as_str().unwrap_or("");
    let worker = workers::link(data, id).filter(|_| summary.is_none());
    if let Some(mut l) = worker.filter(|l| l.report.iter().any(|r| r == turn)) {
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
        if writes && let Some(why) = summary {
            req["renewing"] = why.into();
        }
        owner::call(data, id, req)
    };
    if summary.is_some() {
        // Every tool call is refused while it's there; the daemon takes it away at the turn's end.
        let flag = core::summary::flag(&spec.dir);
        std::fs::write(&flag, b"")?;
        let msg = Message::plain(core::summary::PROMPT);
        let reply = core::send(&spec, &f, child, &call, &cid, "summary", &msg, None, None);
        if reply["ok"] != true {
            let _ = std::fs::remove_file(flag);
        }
        return Ok(reply);
    }
    // Another agent picked carries on from the hand-off; another model of this one, in the same
    // conversation, told why it stopped [D110, D124].
    let msg = match why == "switch" && f.picked.is_none() {
        true => Message::plain(core::switch::SWITCHED),
        false => Message::plain(""),
    };
    // With what the cut turn's agent never took of the steers written to it [D66].
    let told = crate::routing::told(data, &spec);
    crate::peers::held::recovery(data, id, || {
        core::with_back(&told, &f, child, &call, &cid, "system", &msg, None, None)
    })
}
