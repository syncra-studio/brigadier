//! A worktree other sessions share ("Existing worktree"): handed on with its record when the session that made
//! it is deleted, its folder kept for it [D35, D1080].

use super::{Owned, RECORD, read, write};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The worktree a session's record holds, its own or one handed on to it [D1080].
pub fn folder(dir: &Path) -> Option<PathBuf> {
    read(dir).ok().flatten()?.path.map(PathBuf::from)
}

/// Marks the folder of a deleted session that still holds a worktree another session uses: not
/// a session any more, removed with that worktree [D35, D1080].
pub const RETAINED: &str = "retained";

/// Hands the worktree's record, and how its setup went, from `from` to `to`, a session that
/// still uses it [D263, D1080]. Run again after a crash, it finishes what it began. Both callers
/// hold the checkout lock.
pub fn handover(from: &Path, to: &Path) -> io::Result<()> {
    let Some(mut owned) = read(from)? else {
        return Ok(());
    };
    let maker = from.file_name().map(|n| n.to_string_lossy().into_owned());
    owned.inherited = owned.inherited.or(maker);
    for name in [
        "setup.started",
        "setup.exit",
        "setup.log",
        "worktree-setup.json",
    ] {
        if from.join(name).exists() && !to.join(name).exists() {
            fs::copy(from.join(name), to.join(name))?;
        }
    }
    if owned
        .path
        .as_deref()
        // The record's path is canonical; the session's folder may not be.
        .is_some_and(|p| Path::new(p).starts_with(fs::canonicalize(from).unwrap_or(from.into())))
    {
        fs::write(from.join(RETAINED), b"")?;
    }
    write(to, &owned)?;
    fs::remove_file(from.join(RECORD))
}

/// The folder of the session that made a handed-on worktree, kept only for it [D35, D1080].
pub(super) fn drop_maker(owned: &Owned) -> io::Result<()> {
    if let Some(maker) = owned.path.as_deref().and_then(|p| Path::new(p).parent())
        && owned.inherited.is_some()
        && maker.join(RETAINED).exists()
        && !maker.join("session.json").exists()
    {
        fs::remove_dir_all(maker)?;
    }
    Ok(())
}
