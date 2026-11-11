//! Settings › Archived's list [D191, D2014]: the archived sessions a search, a kind, a project and
//! an order show, in groups (a group per project, in the order of its first row, then the chats),
//! and the project menu's choices. The page only draws it [D71].

use brigadier_core as core;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;

/// A row's group: its project, or the chats outside any.
fn group_of(row: &Value) -> &str {
    row["project"].as_str().unwrap_or("chats")
}

pub fn list(
    data: &Path,
    rows: &BTreeMap<String, Value>,
    projects: &BTreeMap<String, Value>,
    req: &Value,
) -> Value {
    let name = |key: &str| match key {
        "chats" => "Chats".to_string(),
        id => projects
            .get(id)
            .and_then(|p| p["name"].as_str())
            .unwrap_or("Project")
            .to_string(),
    };
    let archived: Vec<Value> = rows
        .values()
        .filter(|r| r["archived"].as_u64().is_some())
        .map(|r| {
            let id = r["id"].as_str().unwrap_or("");
            let created = core::load(data, id).ok().map(|s| s.created);
            json!({"id": id, "title": r["title"], "project": r["project"], "archived": r["archived"],
                "updated": r["updated"], "created": created, "backend": r["backend"], "lifecycle": r["lifecycle"]})
        })
        .collect();

    // The project menu: every project with something archived, by name, then the chats.
    let mut keys: Vec<&str> = archived.iter().map(group_of).collect();
    keys.sort_unstable();
    keys.dedup();
    let mut named: Vec<(String, String)> = (keys.iter())
        .filter(|k| **k != "chats")
        .map(|k| (k.to_string(), name(k)))
        .collect();
    named.sort_by_key(|(_, label)| label.to_lowercase());
    let mut choices = vec![json!({"value": "all", "label": "All projects"})];
    choices.extend(named.iter().map(|(v, l)| json!({"value": v, "label": l})));
    if keys.contains(&"chats") {
        choices.push(json!({"value": "chats", "label": "Chats"}));
    }

    let text = |key: &str, default: &'static str| req[key].as_str().unwrap_or(default).to_string();
    let (query, kind, order) = (
        text("query", ""),
        text("kind", "all"),
        text("order", "updated"),
    );
    // A project whose last archived session left shows them all again.
    let project = Some(text("project", "all"))
        .filter(|p| p == "all" || keys.contains(&p.as_str()))
        .unwrap_or_else(|| "all".into());
    let words: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(String::from)
        .collect();
    let mut shown: Vec<&Value> = (archived.iter())
        .filter(|r| match kind.as_str() {
            "session" => !r["project"].is_null(),
            "chat" => r["project"].is_null(),
            _ => true,
        })
        .filter(|r| project == "all" || group_of(r) == project)
        .filter(|r| {
            let title = r["title"].as_str().unwrap_or("").to_lowercase();
            words.iter().all(|w| title.contains(w))
        })
        .collect();
    match order.as_str() {
        "alphabetical" => {
            shown.sort_by_key(|r| r["title"].as_str().unwrap_or("").to_lowercase());
        }
        "created" => shown.sort_by_key(|r| std::cmp::Reverse(r["created"].as_u64())),
        _ => shown.sort_by_key(|r| std::cmp::Reverse(r["updated"].as_u64())),
    }

    let mut groups: Vec<(String, Vec<&Value>)> = vec![];
    for row in shown {
        let key = group_of(row);
        match groups.iter_mut().find(|(k, _)| k == key) {
            Some((_, rows)) => rows.push(row),
            None => groups.push((key.into(), vec![row])),
        }
    }
    groups.sort_by_key(|(key, _)| key == "chats");
    let groups: Vec<Value> = (groups.into_iter())
        .map(|(key, rows)| json!({"label": name(&key), "key": key, "rows": rows}))
        .collect();
    let narrowed = !words.is_empty() || kind != "all" || project != "all";
    json!({"ok": true, "groups": groups, "projects": choices, "narrowed": narrowed,
        "total": archived.len()})
}
