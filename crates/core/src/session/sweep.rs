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

/// At the daemon's start, after `worktrees::sweep`'s own: a restore
/// cut short rolls back (the session stays archived), a delete runs again with the choice it was given.
pub fn sweep(data: &Path) {
    for id in ids(data) {
        let dir = session_dir(data, &id);
        let Some(cut) = intent(&dir) else { continue };
        match cut["op"].as_str() {
            Some("archive") => {}
            Some("restore") => {
                if let (Ok(_one), Ok(spec)) = (worktrees::lock(&dir), crate::load(data, &id))
                    && undo_restore(&spec).is_ok()
                {
                    let _ = clear(&dir, INTENT);
                }
            }
            _ => {
                if let (Ok(spec), Ok(f)) = (crate::load(data, &id), crate::fold(&dir, false)) {
                    delete(&spec, &f.fold, cut["drop_branch"] == true);
                }
            }
        }
    }
}

/// Each archive cut short finishes, its host stopped first, which may not have been: off the daemon's
/// start, for a worktree may be big to remove.
pub fn archives(data: &Path, stop: impl Fn(&str) -> io::Result<()>) {
    for id in ids(data) {
        let dir = session_dir(data, &id);
        if intent(&dir).is_some_and(|i| i["op"] == "archive")
            && let Ok(_one) = worktrees::lock(&dir)
            // Not one an archive at work now, which held the lock, has finished since.
            && intent(&dir).is_some_and(|i| i["op"] == "archive")
            && let Ok(spec) = crate::load(data, &id)
            && let Err(e) = stopped(&spec, || stop(&id))
        {
            eprintln!("brigadierd: archiving {id}: {e}");
        }
    }
}
