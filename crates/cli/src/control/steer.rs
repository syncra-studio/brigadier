//! A message into the turn that runs.

use super::{deliver, new_cid, refused, send};
use brigadier_core::{self as core, adapters};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// A message into the turn that runs, where the agent can take one [D109, D159], from `origin`:
/// the user, or another session's `peer:<id>` [D2034]. `queued`: the caller holds the queue's lock.
pub fn steer_as(
    data: &Path,
    id: &str,
    text: &str,
    parts: &Value,
    cid: Option<&str>,
    origin: &str,
    queued: bool,
) -> io::Result<Value> {
    let spec = core::load(data, id)?;
    let cid = cid.map_or_else(new_cid, String::from);
    core::message::take(data, &spec.dir, parts, None)?;
    // With no turn to take it the user's starts one, which carries on a block its subagents or
    // workers hold open [D521]; a turn that began meanwhile takes it as any steer.
    if origin == "user" && core::fold(&spec.dir, true)?.fold.turns.is_empty() {
        let (p, c) = (parts.clone(), Some(cid.as_str()));
        let reply = send(data, &spec, text, p, c, None, None, queued)?;
        if reply["error"] != "busy: a turn is running" {
            return Ok(reply);
        }
    }
    steer_turn(data, &spec, text, parts, &cid, origin)
}

/// The same, its files taken, into a running turn alone: it never starts one.
pub fn steer_turn(
    data: &Path,
    spec: &core::Spec,
    text: &str,
    parts: &Value,
    cid: &str,
    origin: &str,
) -> io::Result<Value> {
    let msg = core::message::compose(spec, text, parts.clone())?;
    let mut req = json!({"cid": cid, "text": text, "steer": true, "origin": origin});
    if core::message::direct(&spec.dir, cid, origin) {
        req["direct"] = true.into();
    }
    if !parts.is_null() {
        req["parts"] = msg.parts;
    }
    let images = msg.images;
    deliver(data, &spec.id, req, false, |f| {
        let running = f.turns.first().is_some_and(|t| t.began);
        let can = adapters::get(&f.backend).is_some_and(|a| a.can().steer);
        match (running, can) {
            (false, _) => Err(refused("not_running", Value::Null)),
            (_, false) => Err(refused("unsupported", Value::Null)),
            _ => Ok(
                json!({"kind": "steer", "text": msg.agent, "images": images, "commands": msg.commands}),
            ),
        }
    })
}
