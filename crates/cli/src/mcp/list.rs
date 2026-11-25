//! `mcp list`: the servers by name, with where each is.

use super::str;
use serde_json::{Value, json};

pub(super) fn list(all: &[Value]) -> Value {
    let list: Vec<Value> = (all.iter())
        .map(|s| json!({"name": s["name"], "agent": s["agent"], "at": at(s)}))
        .collect();
    let text: String = match list.is_empty() {
        true => "No MCP servers.\n".into(),
        false => (list.iter())
            .map(|s| {
                format!(
                    "{}  {} · {}\n",
                    str(&s["name"]),
                    str(&s["agent"]),
                    str(&s["at"])
                )
            })
            .collect(),
    };
    json!({"ok": true, "servers": list, "text": text + "`brigadier mcp tools <server>` lists its tools."})
}

/// Where a server is, without what may hold a secret: a URL to its `?`, a command without its
/// arguments.
fn at(s: &Value) -> String {
    match s["url"].as_str() {
        Some(url) => {
            let plain = url.split(['?', '#']).next().unwrap_or("");
            // `https://user:key@host` too.
            match plain.split_once("://") {
                Some((scheme, rest)) if rest.split('/').next().is_some_and(|a| a.contains('@')) => {
                    format!(
                        "{scheme}://{}",
                        rest.split_once('@').map_or(rest, |(_, r)| r)
                    )
                }
                _ => plain.into(),
            }
        }
        None => str(&s["command"]).into(),
    }
}
