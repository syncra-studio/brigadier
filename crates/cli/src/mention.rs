//! The `@` menu's search, as the old app's: with nothing typed, its sections (Workers, Files, the
//! top folders, the newest chats); typed, one list ranked across files, folders and other
//! sessions, capped. Rust searches; the UI only marks the matched letters. Each reply echoes its
//! query, so an older one drops [D71, D127, D2010, D2021].

use brigadier_core::git::{self, Target, files};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;

/// The ranked list's rows, and each section's, as the old app's.
const RESULT_ROWS: usize = 8;
const SECTION_ROWS: usize = 5;

/// `{owner: "@home" | id, project?, q}` → `{ok, query, groups}`.
pub fn run(data: &Path, rows: &BTreeMap<String, Value>, req: &Value) -> Value {
    let (owner, q) = (
        req["owner"].as_str().unwrap_or(""),
        req["q"].as_str().unwrap_or(""),
    );
    let target = match req["project"].as_str() {
        Some(p) => Target::Project(p),
        None => Target::Session(owner),
    };
    // A chat with no project has no checkout: its files are none, its chats still there.
    let found = git::checkout(data, &target)
        .and_then(|c| files::mention(&c, q, &AtomicBool::new(false)))
        .unwrap_or_default();
    let mut chats: Vec<&Value> = (rows.values())
        .filter(|r| r["id"] != owner && matches!(r["archived"], Value::Null | Value::Bool(false)))
        .collect();
    chats.sort_by_key(|r| std::cmp::Reverse(r["touched"].as_u64().unwrap_or(0)));
    let chat = |r: &Value| {
        let title = r["title"]
            .as_str()
            .filter(|t| !t.is_empty())
            .unwrap_or("New session");
        json!({"id": r["id"], "type": "chat", "label": title})
    };
    let path = |(_, p, folder): &(u8, String, bool)| {
        let (detail, name) = p
            .rsplit_once('/')
            .map_or((None, p.as_str()), |(d, n)| (Some(d), n));
        json!({"id": p, "type": if *folder { "folder" } else { "file" }, "label": p, "name": name, "detail": detail})
    };
    let groups = if q.is_empty() {
        let top = found
            .iter()
            .filter(|f| f.2 && !f.1.contains('/'))
            .take(SECTION_ROWS);
        json!([
            // Drawn as the old app's, filled once wave 4 brings workers [D2021].
            {"title": "Workers", "items": []},
            {"title": "Files", "items": [], "note": "Type to search for files"},
            {"title": "Folders", "items": top.map(path).collect::<Vec<_>>()},
            {"title": "Chats", "items": chats.iter().take(SECTION_ROWS).map(|r| chat(r)).collect::<Vec<_>>()},
        ])
    } else {
        let query = q.to_lowercase();
        // The old app's tie order: files, then folders, then chats.
        let mut all: Vec<(u8, u8, usize, Value)> = (found.iter().take(RESULT_ROWS * 4))
            .map(|f| (f.0, u8::from(f.2), f.1.len(), path(f)))
            .collect();
        for r in &chats {
            let title = chat(r);
            if let Some(rank) = files::rank(title["label"].as_str().unwrap_or(""), &query) {
                all.push((rank, 2, 0, title));
            }
        }
        all.sort_by_key(|a| (a.0, a.1, a.2));
        let items: Vec<Value> = all.into_iter().take(RESULT_ROWS).map(|(.., v)| v).collect();
        json!([{"title": null, "items": items}])
    };
    json!({"ok": true, "query": q, "groups": groups})
}
