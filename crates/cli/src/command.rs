//! `command <id> <name>`: one of the agent's own commands that runs at once, such as its compact,
//! through the running agent's own channel, logged and delivered as a steer is [D2009, D2011].

use crate::control::{deliver, new_cid, refused};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let (id, name) = (crate::arg(args, 1)?, crate::arg(args, 2)?);
    let msg = json!({"kind": "command", "name": name});
    let req = json!({"cid": new_cid(), "control": msg});
    let reply = deliver(data, id, req, false, |f| {
        let listed = (f
            .commands
            .get(&f.backend)
            .and_then(Value::as_array)
            .into_iter())
        .flatten()
        .any(|c| c["name"] == name && c["instant"] == true);
        match listed {
            true => Ok(msg.clone()),
            false => Err(refused(
                "unsupported",
                "This agent has no command by that name".into(),
            )),
        }
    })?;
    if reply["ok"] == true {
        return Ok(json!({"ok": true}));
    }
    let error = match (reply["error"].as_str(), reply["why"].as_str()) {
        (Some("not_running"), _) => "The agent isn't running. Send it a message first.",
        (Some("busy"), _) => "The session is busy. Try again.",
        // Its adapter's refusal, or the agent's own.
        (Some("unsupported" | "agent"), Some(why)) => why,
        _ => "The agent couldn't run it.",
    };
    Ok(json!({"ok": false, "error": error}))
}
