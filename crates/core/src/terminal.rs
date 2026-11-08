//! Opening a session's terminal [D47]: the CLI's interactive mode on the session's conversation.
//! The host makes the handoff from chat atomic; a mirror copies the terminal's work into the log,
//! so the chat shows it too. One writer per conversation, always: the host's one child.

use crate::fold::Fold;
use crate::{Call, Spec, adapters, cli_version};
use serde_json::{Value, json};

/// Where a terminal's hooks keep what they report, in the session folder, for its mirror to read.
pub const HOOKS: &str = "hooks.jsonl";

/// What the terminal needs that only the caller knows: its size, and the command line of the
/// mirror for (backend, conversation, cursor, log length at the handoff).
pub struct Ask<'a> {
    pub cols: u16,
    pub rows: u16,
    pub mirror: &'a dyn Fn(&str, &str, &str, u64) -> Value,
}

/// Opens the terminal, or says why not. `ping` is the host's answer taken before `f` was folded,
/// so the host can refuse if anything reached the log in between.
pub fn open(spec: &Spec, f: &Fold, ping: &Value, call: Call, ask: Ask) -> Value {
    // Asked first: a host that can't do this is told nothing and nothing is touched.
    let caps = ping["caps"].as_array().into_iter().flatten();
    if !caps.into_iter().any(|c| c == "terminal") {
        return json!({"ok": false, "error": "old_host", "message": "This session's host is on an older build. It moves to the new one once nothing runs."});
    }
    if ping["pty"] == true {
        return json!({"ok": true, "spawn": ping["spawn"], "open": true});
    }
    let b = if f.backend.is_empty() {
        &spec.backend
    } else {
        &f.backend
    };
    let Some(a) = adapters::get(b) else {
        return json!({"ok": false, "error": format!("unknown backend {b}")});
    };
    // A chat turn holds the conversation; the terminal opens once it ends (proposed, O7).
    let running = !ping["child"].is_null();
    if running && (a.per_turn() || f.turns.iter().any(|t| t.delivered.is_some())) {
        return json!({"ok": false, "error": "turn_running", "message": "A turn is running. The terminal opens when it ends."});
    }
    let level = match level(spec, a) {
        Ok(level) => level,
        Err(refusal) => return refusal,
    };
    // On the account the session runs on now [D51].
    let spec = &crate::as_run(
        &Spec {
            level,
            ..spec.clone()
        },
        f,
        b,
        None,
    );
    // Its account gets the project's trust entry first; a failure only means it may ask [D166].
    let _ = crate::trust::ensure(spec, a);
    let (launch, conv) = match a.terminal(spec, f.resume.get(b).map(String::as_str)) {
        Ok(l) => l,
        Err(e) => return json!({"ok": false, "error": "unsupported", "message": e}),
    };
    let len = ping["len"].as_u64().unwrap_or(0);
    let env: serde_json::Map<String, Value> =
        launch.env.into_iter().map(|(k, v)| (k, v.into())).collect();
    let mut req = json!({"op": "spawn", "argv": crate::worktrees::wrap(&crate::data_of(spec), spec, launch.argv), "env": env, "cwd": spec.cwd, "pty": true,
        "cols": ask.cols, "rows": ask.rows, "keep_stdin": true, "backend": b,
        "cli_version": cli_version(spec, a), "replace": running, "if_len": len});
    if let Some(cursor) = a.mirror_from(spec, &conv) {
        req["mirror"] = (ask.mirror)(b, &conv, &cursor, len);
    }
    let mut reply = call(req).unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}));
    // Something reached the log since the ping (a send, the agent's output): say so, never guess.
    if reply["error"] == "changed" {
        reply["message"] = "The session changed while the terminal was opening. Try again.".into();
    }
    reply
}

/// The level a terminal runs at, re-checked as a turn's is: the session's, held to Ask in a held
/// project; an agent that can't hold it there is refused, never run unheld [D166, D243, stream D2].
pub fn level(spec: &Spec, a: &dyn adapters::Adapter) -> Result<Option<String>, Value> {
    let held = crate::projects::held(&crate::data_of(spec), spec);
    match crate::level(spec, a, held) {
        Ok(level) => Ok(level.map(String::from)),
        Err(_) if held => Err(
            json!({"ok": false, "error": "held", "message": format!("This folder isn't trusted, so its sessions run under Ask, which {} can't do yet. Trust the folder in Project settings to run it.", a.label())}),
        ),
        Err(e) => Err(json!({"ok": false, "error": "level", "message": e})),
    }
}
