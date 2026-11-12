//! A setup run's state from its log: whether it runs, how it ended, and what it printed.

use crate::owner;
use brigadier_core as core;
use brigadier_core::adapters::{Adapter, setup};
use brigadier_frames::log::{self, Reader};
use serde_json::{Value, json};
use std::path::Path;

/// A setup run's state; with the agent, the code page or device code a running sign-in printed,
/// or its own error words once it failed; and once it failed, or an update ended, its last line in
/// the CLI's own words [D2077].
pub fn run_state(data: &Path, id: &str, agent: Option<&dyn Adapter>) -> Value {
    let Ok(spec) = core::load(data, id) else {
        return Value::Null;
    };
    let ping = owner::call(data, id, json!({"op": "ping"})).unwrap_or_default();
    let running = !ping["child"].is_null();
    let action = spec.opts.get("setup").map(String::as_str);
    // Its output is read only for an agent's sign-in: its code while it runs, its error after.
    let page = action == Some("sign-in") && agent.is_some();
    let (mut exited, mut out) = (Value::Null, Vec::new());
    if let Ok(mut r) = Reader::open(&spec.dir.join("log"), 0, 0) {
        let wanted = |k| k == log::EXITED || ((page || !running) && k == log::PTY);
        while let Ok(Some(f)) = r.next_with(wanted) {
            if f.kind == log::EXITED {
                exited = serde_json::from_slice(&f.data).unwrap_or_default();
            } else if f.kind == log::PTY {
                out.extend_from_slice(&f.data);
            }
        }
    }
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
