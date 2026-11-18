//! Home's tabs are per project, as the old app's `draft:<project>`: `@home:<project>`, and `@home`
//! for a chat in none [D706]. Their notes share one folder until a session takes them.

use super::{CHAT, Tabs, file, lock, read, write};
use crate::{HOME_DRAFT, attach::note};
use brigadier_core as core;
use std::fs;
use std::io;
use std::path::Path;

pub(super) fn is_home(id: &str) -> bool {
    id == HOME_DRAFT || id.starts_with("@home:")
}

/// A note no Home has open goes, its side chats too: there's no session to list it [D280, D287].
/// A session's keeps its side chats for History [D288].
pub(super) fn drop_closed_notes(data: &Path) {
    let homes: Vec<Tabs> = (fs::read_dir(data).into_iter().flatten().flatten())
        .map(|e| e.path())
        .filter(|p| {
            (p.file_name().and_then(|n| n.to_str()))
                .is_some_and(|n| n.starts_with("home-tabs") && n.ends_with(".json"))
        })
        .map(|p| read(&p))
        .collect();
    let open = |note: &str| {
        (homes.iter().flat_map(|h| &h.tabs))
            .any(|t| t.kind == "note" && t.target.as_deref() == Some(note))
    };
    let dir = note::home(data);
    for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if open(stem) {
            continue;
        }
        // A chat's record goes once its chats have, so one that failed is tried again.
        if path.extension().is_some_and(|e| e == "chat") {
            let _ = note::drop_chat(data, &dir, stem);
        } else {
            let _ = fs::remove_file(path);
        }
    }
}

/// A session made from Home takes its project's Home tabs, in order, with the one in front, as the
/// old app's did. The session's file is written first: a crash between the two leaves tabs in both
/// places rather than in neither.
pub fn carry(data: &Path, to: &str) -> io::Result<()> {
    let spec = core::load(data, to)?;
    let key = (spec.project.as_ref()).map_or(HOME_DRAFT.into(), |p| format!("@home:{p}"));
    let _home = lock(data, &key)?;
    let _one = lock(data, to)?;
    let from = file(data, &key);
    let mut home = read(&from);
    if home.tabs.is_empty() {
        return Ok(());
    }
    let carried = Tabs {
        rev: 1,
        active: home.active.clone(),
        tabs: std::mem::take(&mut home.tabs),
        closed: vec![],
    };
    write(&file(data, to), &carried)?;
    // Its notes are the session's now, as their tabs are [D280]; other projects' stay on their Home.
    let (notes, into) = (note::home(data), spec.dir.join("notes"));
    for tab in carried.tabs.iter().filter(|t| t.kind == "note") {
        for ext in ["md", "chat"] {
            let name = format!("{}.{ext}", tab.target.as_deref().unwrap_or_default());
            if notes.join(&name).exists() {
                fs::create_dir_all(&into)?;
                fs::rename(notes.join(&name), into.join(&name))?;
            }
        }
    }
    if into.is_dir() {
        note::carried(data, &spec)?;
    }
    home.active = CHAT.into();
    home.rev += 1;
    write(&from, &home)
}
