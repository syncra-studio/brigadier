//! `note <id> read <note> | write <note> <text> | list`: the session's notes, one Markdown file each
//! under `notes/` in its folder, so they go with it [D244]. The app names a note; it's kept once
//! written, and emptied it goes, so no blank note is ever listed.

use crate::{HOME_DRAFT, arg, remove};
use brigadier_core::{self as core, check_id, message::MAX_BYTES};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use std::{fs, io};

/// A note's name, as its tab and the New tab show it: its first line, without a heading's #s.
fn title(text: &str) -> &str {
    text.lines()
        .map(|line| line.trim_start_matches('#').trim())
        .find(|line| !line.is_empty())
        .unwrap_or("")
}

/// Home's notes, before the first message makes its session: they go to it then, and one whose
/// tab is closed first goes (`tabs.rs`) [D280].
pub fn home(data: &Path) -> PathBuf {
    data.join("home-notes")
}

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    let dir = if id == HOME_DRAFT {
        home(data)
    } else {
        core::load(data, id)?;
        core::session_dir(data, id).join("notes")
    };
    let file = |note: &str| check_id(note).map(|()| dir.join(format!("{note}.md")));
    match arg(args, 2)? {
        // One not written yet reads empty: a new note's tab.
        "read" => {
            let text = match fs::read_to_string(file(arg(args, 3)?)?) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
                read => read?,
            };
            Ok(json!({"ok": true, "text": text, "title": title(&text)}))
        }
        "write" => {
            let (path, text) = (file(arg(args, 3)?)?, arg(args, 4)?);
            if text.len() as u64 > MAX_BYTES {
                return Ok(json!({"ok": false, "error": "This note is too long to keep."}));
            }
            if text.trim().is_empty() {
                remove(&path)?;
            } else {
                fs::create_dir_all(&dir)?;
                core::write_atomic(&path, text.as_bytes())?;
            }
            Ok(json!({"ok": true, "title": title(text)}))
        }
        // The newest first, as the old New tab's Recents.
        "list" => {
            let mut notes: Vec<(u64, Value)> = vec![];
            for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
                let path = entry.path();
                let Some(note) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                if path.extension().is_none_or(|e| e != "md") || check_id(note).is_err() {
                    continue;
                }
                let at = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as u64);
                let text = fs::read_to_string(&path).unwrap_or_default();
                notes.push((at, json!({"id": note, "title": title(&text), "at": at})));
            }
            notes.sort_by_key(|n| std::cmp::Reverse(n.0));
            Ok(json!({"ok": true, "notes": notes.into_iter().map(|(_, n)| n).collect::<Vec<_>>()}))
        }
        _ => Err(io::Error::other(crate::USAGE)),
    }
}
