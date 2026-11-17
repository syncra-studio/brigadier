//! OpenCode's own commands and skills for the session's folder, as its V2 API lists them, printed
//! as one line for the adapter; its compact, which runs at once, first [D164, D2009, D2011].

use super::super::{Delivery, encode, home_path};
use super::http::Server;
use super::server::say;
use serde_json::{Value, json};

/// Its compact, which runs at once: all of its list it has before it lists the rest [D2098].
pub(super) fn compact() -> Value {
    json!({"name": "compact", "description": "Compact the conversation", "kind": "command", "path": null, "instant": true})
}

/// Its compact, then the skills its folders hold, the project's first (opencode.ai/docs/skills).
pub(super) fn fixed(cwd: Option<&std::path::Path>) -> Vec<Value> {
    let home = home_path("");
    let local = [".opencode", ".claude", ".agents"].into_iter();
    let roots = (cwd.into_iter()).flat_map(|c| local.clone().map(|d| c.join(d).join("skills")));
    let global = [
        ".config/opencode/skills",
        ".claude/skills",
        ".agents/skills",
    ]
    .map(|d| home.join(d));
    let skills = super::super::files::skills_in(roots.chain(global).map(|r| (r, String::new())));
    std::iter::once(compact()).chain(skills).collect()
}

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
    // Its API names no command's file; a skill's own is a path, a built-in one a `skill:` uri.
    let commands = get("command").into_iter().map(|c| {
        json!({"name": c["name"], "description": c["description"], "kind": "command", "path": null, "instant": false})
    });
    let skills = get("skill").into_iter().map(|k| {
        let path = k["path"].as_str().filter(|p| p.starts_with('/'));
        json!({"name": k["id"], "description": k["description"], "kind": "skill", "path": path, "instant": false})
    });
    let all: Vec<Value> = std::iter::once(compact())
        .chain(commands)
        .chain(skills)
        .collect();
    say(json!({"type": "brigadier.commands", "data": all}));
}

/// Its compact, as `POST /api/session/{id}/compact` [D2011].
pub(super) fn command(spec: &crate::Spec, name: &str) -> Result<Delivery, String> {
    match name {
        "compact" => Ok(Delivery::Stdin(format!(
            "{}\n",
            json!({"compact": true, "id": spec.cid})
        ))),
        _ => Err("This agent has no command by that name".into()),
    }
}

/// Its MCP servers in the folder's `opencode.json(c)` and the user's, read only, each as the relay
/// takes it, the folder's first (opencode.ai/docs/mcp-servers) [D100], with the file it comes
/// from [D565].
pub(super) fn mcp_servers(folder: &std::path::Path) -> Vec<Value> {
    let names = ["opencode.jsonc", "opencode.json"];
    let dirs = [folder.to_path_buf(), home_path(".config/opencode")];
    let files = dirs.iter().flat_map(|d| names.map(|n| d.join(n)));
    let mut all = vec![];
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        let v: Value = serde_json::from_str(&jsonc(&text)).unwrap_or_default();
        // Its current `mcp.servers` and `disabled`, else the older `mcp` and `enabled`.
        let servers = v["mcp"]["servers"].as_object().or(v["mcp"].as_object());
        for (name, d) in servers.into_iter().flatten() {
            let command = d["command"].as_array().cloned().unwrap_or_default();
            let enabled = if d["disabled"] == true {
                json!(false)
            } else {
                d["enabled"].clone()
            };
            all.push(json!({"name": name, "command": command.first(), "args": command.get(1..),
                "env": d["environment"], "url": d["url"], "headers": d["headers"], "enabled": enabled,
                "source": file.display().to_string()}));
        }
    }
    all
}

/// JSON with comments and trailing commas, as plain JSON.
fn jsonc(text: &str) -> String {
    let (mut out, mut chars) = (String::new(), text.chars().peekable());
    let mut string = false;
    while let Some(c) = chars.next() {
        match c {
            '"' if !out.ends_with('\\') || out.ends_with("\\\\") => {
                string = !string;
                out.push(c);
            }
            '/' if !string && chars.peek() == Some(&'/') => {
                chars.by_ref().take_while(|c| *c != '\n').for_each(drop);
                out.push('\n');
            }
            '/' if !string && chars.peek() == Some(&'*') => {
                chars.next();
                let mut last = ' ';
                for c in chars.by_ref() {
                    if last == '*' && c == '/' {
                        break;
                    }
                    last = c;
                }
            }
            '}' | ']' if !string => {
                let trimmed = out.trim_end().len();
                if out[..trimmed].ends_with(',') {
                    out.truncate(trimmed - 1);
                }
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out
}
