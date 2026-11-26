//! The `@` menu's search, as the old app's: with nothing typed, its sections (Workers, Notes, Message
//! directly, Files, the top folders, the newest chats, the session's browser tabs); typed, one list ranked across workers,
//! files, folders and other sessions, capped. Rust searches; the UI only marks the matched letters. Each reply echoes its
//! query, so an older one drops [D71, D127, D2010, D2021].

use brigadier_core::git::{self, Target, files};
use brigadier_core::message::is_image;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::AtomicBool;

/// The ranked list's rows, and each section's, as the old app's.
const RESULT_ROWS: usize = 8;
const SECTION_ROWS: usize = 5;

/// `{owner: "@home" | id, tabs?, project?, q}`, `tabs` the Home draft whose tabs these are → `{ok, query, groups}`.
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
        // No worker is a chat: its own are under Workers, others' none, as the old app's workers weren't conversations.
        .filter(|r| r["worker"].is_null())
        .collect();
    chats.sort_by_key(|r| std::cmp::Reverse(r["touched"].as_u64().unwrap_or(0)));
    let chat = |r: &Value| {
        let title = r["title"]
            .as_str()
            .filter(|t| !t.is_empty())
            .unwrap_or("New session");
        json!({"id": r["id"], "type": "chat", "label": title})
    };
    // The owner's own workers, oldest first; the ones still on hand can take a message directly.
    let mut workers: Vec<&Value> = (rows.values())
        .filter(|r| r["worker"]["parent"] == owner)
        .collect();
    workers.sort_by_key(|r| r["worker"]["started"].as_u64().unwrap_or(0));
    let ended = |r: &Value| {
        let kind = r["worker"]["kind"].as_str().unwrap_or("");
        matches!(
            kind,
            "failed" | "stopped" | "merged" | "doneNotMerged" | "done"
        )
    };
    let title = |r: &Value| r["title"].as_str().unwrap_or("a worker").to_string();
    let worker = |r: &Value| {
        let word = r["worker"]["word"].as_str().unwrap_or("").to_lowercase();
        json!({"id": r["id"], "type": "worker", "label": title(r), "hint": word})
    };
    let direct = |r: &Value, detail: Option<&str>| json!({"id": r["id"], "type": "direct", "label": title(r), "detail": detail});
    let path = |(_, p, folder): &(u8, String, bool)| {
        let (detail, name) = p
            .rsplit_once('/')
            .map_or((None, p.as_str()), |(d, n)| (Some(d), n));
        json!({"id": p, "type": if *folder { "folder" } else { "file" }, "label": p, "name": name, "detail": detail})
    };
    // The session's browser tabs, which a message can hand to its agent [D775]: by address, as Rust knows them.
    let bare = |t: &&str| brigadier_core::check_id(t.strip_prefix("@home:").unwrap_or(t)).is_ok();
    let shown = (req["tabs"].as_str().filter(bare)).unwrap_or(owner);
    let tabs: Vec<Value> = (crate::tabs::browser(data, shown).into_iter())
        .filter(|(_, _, driver)| driver.as_deref().is_none_or(|d| d == owner))
        .map(|(id, url, driver)| {
            let shown = url.split_once("://").map_or(url.as_str(), |(_, rest)| rest);
            let label: String = shown.trim_end_matches('/').chars().take(80).collect();
            let hint = driver.map(|_| "Brigadier has it");
            json!({"id": id, "type": "tab", "label": label, "hint": hint})
        })
        .collect();
    // The project's notes, which a message can hand to its agent whole [D913].
    let notes =
        crate::attach::note::listed(data, owner, req["project"].as_str()).unwrap_or_default();
    let note = |n: &Value| json!({"id": n["id"], "type": "note", "name": n["title"], "label": crate::attach::note::shown_name(n)});
    let groups = if q.is_empty() {
        let top = found
            .iter()
            .filter(|f| f.2 && !f.1.contains('/'))
            .take(SECTION_ROWS);
        json!([
            {"title": "Workers", "items": workers.iter().map(|r| worker(r)).collect::<Vec<_>>()},
            {"title": "Notes", "items": notes.iter().take(SECTION_ROWS).map(note).collect::<Vec<_>>()},
            {"title": "Message directly", "items": workers.iter().filter(|r| !ended(r)).map(|r| direct(r, None)).collect::<Vec<_>>()},
            {"title": "Files", "items": [], "note": "Type to search for files"},
            {"title": "Folders", "items": top.map(path).collect::<Vec<_>>()},
            {"title": "Chats", "items": chats.iter().take(SECTION_ROWS).map(|r| chat(r)).collect::<Vec<_>>()},
            {"title": "Tabs", "items": tabs.iter().take(SECTION_ROWS).collect::<Vec<_>>()},
        ])
    } else {
        let query = q.to_lowercase();
        // The old app's tie order: workers (a mention before its Message directly), files, folders, chats.
        let mut all: Vec<(u8, u8, usize, Value)> = (found.iter().take(RESULT_ROWS * 4))
            .map(|f| (f.0, 1 + u8::from(f.2), f.1.len(), path(f)))
            .collect();
        for r in &workers {
            let name = title(r);
            if let Some(rank) = files::rank(&name, &query) {
                all.push((rank, 0, name.len() * 2, worker(r)));
                if !ended(r) {
                    all.push((
                        rank,
                        0,
                        name.len() * 2 + 1,
                        direct(r, Some("Message directly")),
                    ));
                }
            }
        }
        for r in &chats {
            let title = chat(r);
            if let Some(rank) = files::rank(title["label"].as_str().unwrap_or(""), &query) {
                all.push((rank, 3, 0, title));
            }
        }
        for n in &notes {
            let row = note(n);
            let of = |v: &Value| files::rank(v.as_str().unwrap_or(""), &query);
            // Past what the row shows, a long name is found too: a given one as any name, a paragraph
            // by its words only, as nearly any letters are in one in order.
            let ranks = [
                of(&row["label"]),
                of(&n["name"]),
                of(&n["whole"]).filter(|r| *r < 2),
            ];
            if let Some(rank) = ranks.into_iter().flatten().min() {
                all.push((rank, 0, 1, row));
            }
        }
        for t in tabs {
            if let Some(rank) = files::rank(t["label"].as_str().unwrap_or(""), &query) {
                all.push((rank, 4, 0, t));
            }
        }
        all.sort_by_key(|a| (a.0, a.1, a.2));
        let items: Vec<Value> = all.into_iter().take(RESULT_ROWS).map(|(.., v)| v).collect();
        json!([{"title": null, "items": items}])
    };
    json!({"ok": true, "query": q, "groups": groups})
}

/// `{owner, paths}` → `{ok, found: {asked: {path, folder}}}`: which of an answer's path-like words
/// name a file or folder of the session's checkout, so the answer draws it as the composer's chip
/// [D251]. A path under the checkout's root counts as the relative one; a bare file name, when
/// exactly one file has it. A whole path elsewhere that exists (`/Users/me/Downloads/a.png`, `~/a.png`)
/// counts too, as `outside` [D290]; each hit says where it is on disk (`at`) and whether it's an image.
pub fn paths(data: &Path, req: &Value) -> Value {
    let target = Target::Session(req["owner"].as_str().unwrap_or(""));
    // Where a tab of the file reads it: a plain folder too, a no-project worker's edit folder [C70].
    let checkout = git::files_of(data, &target).ok();
    let listed =
        (checkout.as_ref()).and_then(|c| files::mention(c, "", &AtomicBool::new(false)).ok());
    // A plain folder has no listing: a path in it counts when it's there [D388].
    let plain = checkout.as_ref().filter(|_| listed.is_none());
    let all = listed.unwrap_or_default();
    let root = (checkout.as_ref()).map_or_else(String::new, |c| format!("{}/", c.root.display()));
    let home = std::env::var("HOME").unwrap_or_default();
    let mut found = serde_json::Map::new();
    for asked in (req["paths"].as_array().into_iter().flatten()).filter_map(Value::as_str) {
        let whole = asked
            .strip_prefix("~/")
            .map_or_else(|| asked.to_string(), |rest| format!("{home}/{rest}"));
        // Under the root as it is, its folder's links followed (`/tmp/a` is in `/private/tmp/`); its
        // own name kept, so a tracked link isn't taken for its target.
        let path = Path::new(&whole);
        let real = (path.parent().zip(path.file_name()))
            .filter(|_| whole.starts_with('/'))
            .and_then(|(up, name)| Some(std::fs::canonicalize(up).ok()?.join(name)))
            .map_or_else(|| whole.clone(), |p| p.display().to_string());
        if whole.starts_with('/') && (root.is_empty() || !real.starts_with(&root)) {
            if let Ok(meta) = std::fs::metadata(&whole) {
                let image = !meta.is_dir() && is_image(Path::new(&whole));
                found.insert(asked.into(), json!({"path": whole, "at": whole, "folder": meta.is_dir(), "image": image, "outside": true}));
            }
            continue;
        }
        let want = real
            .strip_prefix(&root)
            .unwrap_or(&real)
            .trim_end_matches('/');
        let mut named = all
            .iter()
            .filter(|f| !f.2 && f.1.rsplit('/').next() == Some(want));
        let alone = named.next().filter(|_| named.next().is_none());
        let there = || {
            let at = git::inside(plain?, want).ok()?;
            Some((want.to_string(), std::fs::metadata(at).ok()?.is_dir()))
        };
        let hit = (all.iter().find(|f| f.1 == want).or(alone))
            .map(|(_, path, folder)| (path.clone(), *folder))
            .or_else(there);
        if let Some((path, folder)) = hit {
            let at = format!("{root}{path}");
            let image = !folder && is_image(Path::new(&path));
            found.insert(
                asked.into(),
                json!({"path": path, "at": at, "folder": folder, "image": image}),
            );
        }
    }
    json!({"ok": true, "found": found})
}
