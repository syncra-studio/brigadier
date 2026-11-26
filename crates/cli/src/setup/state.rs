//! A setup run's state from its log: whether it runs, how it ended, and what it printed.

use crate::owner;
use brigadier_core as core;
use brigadier_core::adapters::{Adapter, setup};
use brigadier_frames::log::{self, Reader};
use serde_json::{Value, json};
use std::path::Path;

/// Whether run `id`'s host has its command running, and whether that's a guess: a host still there
/// that didn't answer in time (a loaded Mac, a stopped host) may still run it, so it's never taken
/// for ended or closed on one missed ping.
pub(crate) fn runs(data: &Path, id: &str) -> (bool, bool) {
    match owner::call(data, id, json!({"op": "ping"})) {
        Ok(ping) => (!ping["child"].is_null(), false),
        Err(_) => {
            let there = owner::state(data, id) != core::fold::Owner::Dead;
            (there, there)
        }
    }
}

/// A setup run's state; with the agent, the code page or device code a running sign-in printed,
/// or its own error words once it failed; and once it failed, or an update ended, its last line in
/// the CLI's own words [D2077].
pub fn run_state(data: &Path, id: &str, agent: Option<&dyn Adapter>) -> Value {
    let Ok(spec) = core::load(data, id) else {
        return Value::Null;
    };
    let (running, unsure) = runs(data, id);
    let action = spec.opts.get("setup").map(String::as_str);
    // Its output is read only for an agent's sign-in: its code while it runs, its error after.
    let page = action == Some("sign-in") && agent.is_some();
    let (mut exited, mut out) = (Value::Null, Vec::new());
    if let Ok(mut r) = Reader::open(&spec.dir.join("log"), 0, 0) {
        let wanted = |k| k == log::EXITED || ((page || !running || unsure) && k == log::PTY);
        while let Ok(Some(f)) = r.next_with(wanted) {
            if f.kind == log::EXITED {
                exited = serde_json::from_slice(&f.data).unwrap_or_default();
            } else if f.kind == log::PTY {
                out.extend_from_slice(&f.data);
            }
        }
    }
    // Unanswered, its own end record is what says it ended.
    let running = running && !(unsure && !exited.is_null());
    // A sign-in whose command wasn't found (127: a shim whose CLI is gone) is no run: the card shows what
    // the check finds again, Install, not the shim's own line [D32].
    if page && !running && exited["code"] == 127 {
        return Value::Null;
    }
    let text = String::from_utf8_lossy(&out);
    let device_code = agent.filter(|_| running).and_then(|a| a.device_code(&text));
    let shows = (running && agent.is_some_and(|a| a.code_page())) || device_code.is_some();
    let failed = !running && page && exited["code"] != 0;
    let error = agent
        .filter(|_| failed)
        .and_then(|a| a.sign_in_error(&text));
    let ended_badly =
        exited["code"].as_i64().is_some_and(|c| c != 0) || !exited["signal"].is_null();
    let said = ended_badly || (action == Some("update") && !exited.is_null());
    json!({"id": id, "action": action, "running": running, "code": exited["code"],
        "signal": exited["signal"], "code_page": setup::code_page(&out).filter(|_| shows),
        "device_code": device_code, "error": error, "prompts": page && agent.is_some_and(|a| a.sign_in_prompts()),
        "reason": said.then(|| setup::reason(&out)).flatten()})
}
