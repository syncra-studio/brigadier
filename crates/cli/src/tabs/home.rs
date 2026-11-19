//! Home's tabs are per project, as the old app's `draft:<project>`: `@home:<project>`, and `@home`
//! for a chat in none [D706]. Their notes are their project's already [D913].

use super::{CHAT, Tabs, file, lock, read, write};
use crate::HOME_DRAFT;
use brigadier_core as core;
use std::io;
use std::path::Path;

pub(super) fn is_home(id: &str) -> bool {
    id == HOME_DRAFT || id.starts_with("@home:")
}

/// A session made from Home takes its project's Home tabs, in order, with the one in front, as the
/// old app's did. The session's file is written first: a crash between the two leaves tabs in both
/// places rather than in neither. `chat`: from New chat's draft (`@home`), whichever project it picked [D863].
pub fn carry(data: &Path, to: &str, chat: bool) -> io::Result<()> {
    let spec = core::load(data, to)?;
    let key = (spec.project.as_ref().filter(|_| !chat))
        .map_or(HOME_DRAFT.into(), |p| format!("@home:{p}"));
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
