//! The daemon's start: an archive, restore or delete cut short finishes or rolls back.

use super::{
    ARCHIVED, Guard, INTENT, clear, delete, holder, intent, shared_claim, sharers, stopped,
};
use crate::{Spec, data_of, ids, session_dir, worktrees};
use std::io;
use std::path::Path;

/// Rolls back a restore cut short: its worktree is freed again, unless another session still
/// works there unarchived [D1080]; a claim another session works in stays, as archive left it.
fn undo_restore(spec: &Spec) -> io::Result<()> {
    let (others, _held) = sharers(spec)?;
    if others.iter().any(|o| !o.dir.join(ARCHIVED).exists()) {
        return Ok(());
    }
    // What a guard kept stays.
    let may = super::litter::guarded(spec, Guard::Lossless);
    let free = |rec: &Path| match may(rec) {
        true => worktrees::free(rec),
        false => Ok(()),
    };
    free(&holder(spec, &others))?;
    let data = data_of(spec);
    crate::folder::claims(&spec.dir)
        .iter()
        .try_for_each(|(_, rec)| {
            let _one = worktrees::lock(rec)?;
            match shared_claim(&data, spec, rec) {
                true => Ok(()),
                false => free(rec),
            }
        })
}

/// At the daemon's start, after `worktrees::sweep`'s own: a delete cut short runs again with the choice it was given.
pub fn sweep(data: &Path) {
    for id in ids(data) {
        let dir = session_dir(data, &id);
        let Some(cut) = intent(&dir) else { continue };
        if !matches!(cut["op"].as_str(), Some("archive" | "restore"))
            && let (Ok(spec), Ok(f)) = (crate::load(data, &id), crate::fold(&dir, false))
        {
            delete(&spec, &f.fold, &super::Chosen::of(&cut["drop_branch"]));
        }
    }
}

/// Each archive cut short finishes, its host stopped first, which may not have been, and each restore cut short rolls
/// back (the session stays archived): off the daemon's start, for a worktree may be big to remove. Whether one
/// couldn't, as while the git a daemon left is still at work there.
pub fn cut(data: &Path, stop: impl Fn(&str) -> io::Result<()>) -> bool {
    let mut left = false;
    for id in ids(data) {
        let dir = session_dir(data, &id);
        let op = || intent(&dir).and_then(|i| i["op"].as_str().map(str::to_string));
        if matches!(op().as_deref(), Some("archive" | "restore"))
            && let Ok(_one) = worktrees::lock(&dir)
            && let Ok(spec) = crate::load(data, &id)
        {
            // Read again: one at work now, which held the lock, has finished since.
            let done = match op().as_deref() {
                Some("archive") => stopped(&spec, || stop(&id)),
                Some("restore") => undo_restore(&spec).and_then(|()| clear(&dir, INTENT)),
                _ => continue,
            };
            if let Err(e) = done {
                eprintln!("brigadierd: what cut short {id}: {e}");
                left = true;
            }
        }
    }
    left
}
