//! The relay [D89, D100]: what a session's agent pulls through `brigadier` instead of loading it,
//! a naked worker's only way to them: the user's own skills, read only from each agent's own
//! folders, and past sessions.

use brigadier_core::{self as core, adapters};
use serde_json::{Value, json};
use std::path::Path;

type Spec = (
    &'static str,
    &'static [&'static str],
    &'static [&'static str],
);

/// Each relay command's help, its value flags and its plain flags.
pub fn spec(cmd: &str) -> Option<Spec> {
    Some(match cmd {
        "skill" => (
            "brigadier skill [<name>] [--json]\n\nThe user's skills, from every agent's own folders. With a name, prints that skill's SKILL.md whole and its folder; read its other files there yourself.",
            &[],
            &[],
        ),
        "search" => (
            "brigadier search \"<words>\" [--json]\n\nPast sessions, archived ones too, holding every word: each one's id, title and best matching line. `brigadier read <id>` reads one.",
            &[],
            &[],
        ),
        "mcp" => (
            "brigadier mcp list | tools <server> | call <server> <tool> ['<json>'] [--json]

The user's own MCP servers, from every agent's own config, the same on every agent: `list` names
them, `tools <server>` lists its tools with their input schemas, `call` runs one tool with the JSON
object of its arguments (none: {}) and prints what it answered. One connection per server is kept
for you while you use it, so what a call opens stays good for your next call. A server that needs a
sign-in says so: Brigadier can't sign in to one yet.",
            &[],
            &[],
        ),
        _ => return None,
    })
}

/// `mcp`, its own words past the command: its help, or its reply as asked, JSON or capped text.
pub fn mcp(data: &Path, me: &str, args: &[String]) -> Value {
    let json = args.iter().any(|a| a == "--json");
    if args.iter().any(|a| a == "--help") {
        return json!({"ok": true, "text": spec("mcp").map_or("", |s| s.0)});
    }
    let words: Vec<&str> = (args.iter().skip(1))
        .map(String::as_str)
        .filter(|a| *a != "--json")
        .collect();
    let mut reply = crate::mcp::run(data, me, &words);
    if json {
        reply.as_object_mut().map(|o| o.remove("text"));
    } else if reply["ok"] == true {
        reply =
            json!({"ok": true, "text": crate::agent::cap(reply["text"].as_str().unwrap_or(""))});
    }
    reply
}

/// Runs a relay command, or None for another.
pub fn run(data: &Path, me: &str, cmd: &str, arg: Option<&str>, rows: &[Value]) -> Option<Value> {
    match cmd {
        "skill" => Some(skill(data, me, arg)),
        "search" => Some(search(data, arg.unwrap_or(""), rows)),
        _ => None,
    }
}

/// The user's skills each agent keeps for the caller's folder, by name once: the first agent's.
fn skills(data: &Path, me: &str) -> Vec<Value> {
    let cwd = core::load(data, me).map(|s| s.cwd).unwrap_or_default();
    let mut all: Vec<Value> = vec![];
    for a in adapters::all() {
        for k in a.fixed_commands(Some(Path::new(&cwd)), None) {
            if k["kind"] == "skill"
                && k["path"].is_string()
                && !all.iter().any(|x| x["name"] == k["name"])
            {
                all.push(k);
            }
        }
    }
    all
}

/// The `description:` of a SKILL.md's front matter, on one line; a `>` or `|` block's lines joined.
fn described(text: &str) -> String {
    let front = text
        .strip_prefix("---")
        .and_then(|t| t.split("\n---").next());
    let mut lines = front.into_iter().flat_map(str::lines);
    let Some(first) = lines.find_map(|l| l.strip_prefix("description:")) else {
        return String::new();
    };
    let first = first.trim();
    let d = match first.starts_with(['>', '|']) {
        true => (lines
            .take_while(|l| l.starts_with([' ', '\t']))
            .map(str::trim))
        .collect::<Vec<_>>()
        .join(" "),
        false => first.trim_matches(['"', '\'']).to_string(),
    };
    d.chars().take(200).collect()
}

/// `skill`: the list, or one whole.
fn skill(data: &Path, me: &str, name: Option<&str>) -> Value {
    let all = skills(data, me);
    let read =
        |k: &Value| std::fs::read_to_string(k["path"].as_str().unwrap_or("")).unwrap_or_default();
    let Some(name) = name else {
        let list: Vec<Value> = (all.iter())
            .map(|k| json!({"name": k["name"], "description": described(&read(k)), "path": k["path"]}))
            .collect();
        let text: String = match list.is_empty() {
            true => "No skills.\n".into(),
            false => (list.iter())
                .map(|k| {
                    format!(
                        "{}  {}\n",
                        k["name"].as_str().unwrap_or(""),
                        k["description"].as_str().unwrap_or("")
                    )
                })
                .collect(),
        };
        return json!({"ok": true, "skills": list, "text": text + "`brigadier skill <name>` prints one."});
    };
    let Some(k) = all.iter().find(|k| k["name"] == name) else {
        return json!({"ok": false, "error": format!("No skill {name:?}. `brigadier skill` lists them.")});
    };
    let path = k["path"].as_str().unwrap_or("");
    let folder = Path::new(path)
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let mut text = read(k);
    // The reply's cap cuts from the start; a skill is read from its start.
    if text.len() > 15 << 10 {
        let mut at = 15 << 10;
        while !text.is_char_boundary(at) {
            at -= 1;
        }
        text.truncate(at);
        text += &format!("\n[cut; the rest is in {path}]");
    }
    json!({"ok": true, "name": name, "path": path, "folder": folder,
        "text": format!("{text}\n\n[Its folder: {folder}]")})
}

/// `search`: the sessions holding every word, with their titles from the daemon's rows.
fn search(data: &Path, words: &str, rows: &[Value]) -> Value {
    if words.trim().is_empty() {
        return json!({"ok": false, "error": "`brigadier search` needs words, in quotes."});
    }
    let hits = match crate::index::search(data, words) {
        Ok(h) => h,
        Err(e) => return json!({"ok": false, "error": e.to_string()}),
    };
    let title = |id: &Value| {
        let row = rows.iter().find(|r| r["id"] == *id);
        row.and_then(|r| r["title"].as_str())
            .filter(|t| !t.is_empty())
            .unwrap_or("Untitled")
            .to_string()
    };
    let list: Vec<Value> = (hits.iter())
        .map(|h| json!({"id": h["id"], "title": title(&h["id"]), "line": h["snippet"]}))
        .collect();
    let text: String = match list.is_empty() {
        true => "No session holds every word.\n".into(),
        false => (list.iter())
            .map(|h| {
                format!(
                    "{}  {}\n  {}\n",
                    h["id"].as_str().unwrap_or(""),
                    h["title"].as_str().unwrap_or(""),
                    h["line"].as_str().unwrap_or("")
                )
            })
            .collect(),
    };
    json!({"ok": true, "sessions": list, "text": text})
}
