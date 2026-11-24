//! Home's tabs are per draft, as the old app's `draft:<project>`: `@home:<project>`, and `@home`
//! for Chats', in no project [D706]. Their notes are their project's already [D913].

use super::{CHAT, Tabs, file, lock, read, state, write};
use crate::{HOME_DRAFT, USAGE};
use brigadier_core as core;
use serde_json::Value;
use std::io;
use std::path::Path;

pub(super) fn is_home(id: &str) -> bool {
    id == HOME_DRAFT || id.starts_with("@home:")
}

fn key_of(spec: &core::Spec) -> String {
    (spec.project.as_ref()).map_or(HOME_DRAFT.into(), |p| format!("@home:{p}"))
}

/// A session made from Home takes its project's Home tabs, in order, with the one in front, as the
/// old app's did. The session's file is written first: a crash between the two leaves tabs in both
/// places rather than in neither.
pub fn carry(data: &Path, to: &str) -> io::Result<()> {
    let key = key_of(&core::load(data, to)?);
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
    home.active = CHAT.into();
    home.rev += 1;
    write(&from, &home)
}

/// A start that failed or was discarded gives its tabs back, before any its draft has had since.
pub fn back(data: &Path, spec: &core::Spec) -> io::Result<()> {
    let key = key_of(spec);
    let _home = lock(data, &key)?;
    let _one = lock(data, &spec.id)?;
    let (mine, theirs) = (file(data, &spec.id), file(data, &key));
    let (mut from, mut home) = (read(&mine), read(&theirs));
    if from.tabs.is_empty() {
        return Ok(());
    }
    from.tabs.retain(|t| !home.exists(&t.id));
    home.tabs.splice(0..0, from.tabs.drain(..));
    home.rev += 1;
    write(&theirs, &home)?;
    from.active = CHAT.into();
    from.rev += 1;
    write(&mine, &from)
}

/// Draft `to` takes `ids` from draft `from`, after its own tabs and in their order, its tab in front
/// as it was; one it has a tab for already goes. Safe to do again: `to` is written first.
pub(super) fn take(data: &Path, to: &str, from: &str, ids: &[String]) -> io::Result<Value> {
    if !is_home(to) || !is_home(from) || to == from {
        return Err(io::Error::other(USAGE));
    }
    if from != HOME_DRAFT {
        core::check_id(from.strip_prefix("@home:").unwrap_or(from))?;
    }
    let _home = lock(data, to)?;
    let (mine, theirs) = (file(data, to), file(data, from));
    let (mut now, mut left) = (read(&mine), read(&theirs));
    let (taken, kept): (Vec<_>, _) = (left.tabs.into_iter()).partition(|t| ids.contains(&t.id));
    left.tabs = kept;
    let had = now.clone();
    for mut tab in taken {
        let shown = tab.kind != "browser" && had.same(&tab.kind, &tab.target).is_some();
        if !shown && !now.exists(&tab.id) {
            tab.preview &= !now.tabs.iter().any(|t| t.preview);
            now.tabs.push(tab);
        }
    }
    if now != had {
        now.rev += 1;
        write(&mine, &now)?;
    }
    if !left.exists(&left.active) {
        left.active = CHAT.into();
    }
    left.rev += 1;
    write(&theirs, &left)?;
    Ok(state(&now))
}
