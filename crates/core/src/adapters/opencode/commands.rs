//! OpenCode's own commands and skills for the session's folder, as its V2 API lists them, printed
//! as one line for the adapter; its compact, which runs at once, first [D164, D2009, D2011].

use super::http::Server;
use super::server::say;
use serde_json::{Value, json};

/// Lists both again; one its server can't list stays out, and the listing goes on without it.
pub(super) fn list(server: &Server, dir: &str) {
    let get = |what: &str| -> Vec<Value> {
        let path = format!("/api/{what}?location%5Bdirectory%5D={}", encode(dir));
        let v: Value = (server.request("GET", &path, &Value::Null).ok())
            .filter(|(code, _)| *code < 300)
            .and_then(|(_, body)| serde_json::from_str(&body).ok())
            .unwrap_or_default();
        v["data"].as_array().cloned().unwrap_or_default()
    };
    let compact = json!({"name": "compact", "description": "Compact the conversation",
        "kind": "command", "path": null, "instant": true});
    // Its API names no command's file; a skill's own is a path, a built-in one a `skill:` uri.
    let commands = get("command").into_iter().map(|c| {
        json!({"name": c["name"], "description": c["description"], "kind": "command", "path": null, "instant": false})
    });
    let skills = get("skill").into_iter().map(|k| {
        let path = k["path"].as_str().filter(|p| p.starts_with('/'));
        json!({"name": k["id"], "description": k["description"], "kind": "skill", "path": path, "instant": false})
    });
    let all: Vec<Value> = std::iter::once(compact)
        .chain(commands)
        .chain(skills)
        .collect();
    say(json!({"type": "brigadier.commands", "data": all}));
}

/// A query value, percent-encoded but for URL-safe characters.
fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
