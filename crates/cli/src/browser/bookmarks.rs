//! The old per-profile bookmark file, including import's folder-scoped deduplication.

use brigadier_core::write_atomic;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;
use std::{fs, io};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bookmark {
    id: u64,
    #[serde(flatten)]
    edit: Edit,
    added_ms: i64,
}

#[derive(Serialize, Deserialize)]
struct Edit {
    url: String,
    title: String,
    folders: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Imported {
    #[serde(flatten)]
    edit: Edit,
    added_ms: Option<i64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    next_id: u64,
    bookmarks: Vec<Bookmark>,
}

pub(super) fn run(folder: &Path, args: &[String]) -> io::Result<Value> {
    let file = folder.join("Brigadier Bookmarks.json");
    let mut stored: Stored = match fs::read(&file) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => Stored {
            next_id: 1,
            bookmarks: vec![],
        },
        Err(e) => return Err(e),
    };
    let get = |i| crate::arg(args, i);
    let op = get(0)?;
    let mut out = json!({"ok": true});
    match op {
        "list" => return Ok(json!({"ok": true, "bookmarks": stored.bookmarks})),
        "add" => {
            let edit: Edit = serde_json::from_str(get(1)?)?;
            super::web_address(&edit.url)?;
            let added = Bookmark {
                id: stored.next_id,
                edit,
                added_ms: super::now(),
            };
            stored.next_id += 1;
            out["bookmark"] = serde_json::to_value(&added)?;
            stored.bookmarks.push(added);
        }
        "update" => {
            let id: u64 = get(1)?.parse().map_err(io::Error::other)?;
            let edit: Edit = serde_json::from_str(get(2)?)?;
            super::web_address(&edit.url)?;
            if let Some(bookmark) = stored.bookmarks.iter_mut().find(|b| b.id == id) {
                bookmark.edit = edit;
            }
        }
        "remove" => {
            let id: u64 = get(1)?.parse().map_err(io::Error::other)?;
            stored.bookmarks.retain(|b| b.id != id);
        }
        "import" => {
            let items: Vec<Imported> = serde_json::from_str(get(1)?)?;
            let (mut added, mut skipped) = (0, 0);
            for item in items {
                if super::web_address(&item.edit.url).is_err()
                    || stored
                        .bookmarks
                        .iter()
                        .any(|b| b.edit.url == item.edit.url && b.edit.folders == item.edit.folders)
                {
                    skipped += 1;
                    continue;
                }
                stored.bookmarks.push(Bookmark {
                    id: stored.next_id,
                    edit: item.edit,
                    added_ms: item.added_ms.unwrap_or_else(super::now),
                });
                stored.next_id += 1;
                added += 1;
            }
            out["added"] = added.into();
            out["skipped"] = skipped.into();
        }
        _ => return Err(io::Error::other("Unknown browser bookmarks operation")),
    }
    write_atomic(&file, &serde_json::to_vec(&stored)?)?;
    Ok(out)
}
