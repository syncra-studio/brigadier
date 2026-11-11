//! Re-create an externally removed worktree from its recorded branch [D180, D1187].

use super::{Owned, err, read, restore};
use crate::{Spec, load, projects, share, worktrees};
use std::fs;
use std::io;
use std::path::Path;

pub fn restore_missing(data: &Path, id: &str, busy: &dyn Fn(&Spec) -> bool) -> io::Result<()> {
    crate::check_id(id)?;
    let spec = load(data, id)?;
    let holder = share::holder(data, &spec)
        .ok_or_else(|| io::Error::other("This session has no worktree to restore."))?;
    let _one = worktrees::lock(&holder.dir)?;
    let _fence = crate::rewind::checkout_lock(data, true)?;
    if let Some(why) = crate::session::closed(&spec.dir) {
        return err(why.into());
    }
    for user in share::in_folder(data, Path::new(&spec.cwd), None) {
        if busy(&user) {
            return err("A session using this folder is busy. Restore it once it is idle.".into());
        }
    }
    let owned =
        read(&holder.dir)?.ok_or_else(|| io::Error::other("Its worktree record is gone."))?;
    let path = owned
        .path
        .as_deref()
        .ok_or_else(|| io::Error::other("Its worktree path is unknown."))?;
    match fs::symlink_metadata(path) {
        Ok(_) => return err("This session's folder is already there. Read it again.".into()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    // Remove only this missing path's verified registration; never prune other worktrees [D35].
    let ours = registration(&owned)?;
    if let Some(admin) = owned
        .admin
        .as_deref()
        .filter(|a| ours && Path::new(a).exists())
    {
        fs::remove_dir_all(admin)?;
    }
    let project = spec
        .project
        .as_deref()
        .map(|id| projects::get(data, id))
        .transpose()?;
    let picks = project
        .as_ref()
        .map(|p| p.include.as_slice())
        .unwrap_or_default();
    restore(&holder.dir, picks)?;
    crate::git::checkout(data, &crate::git::Target::Session(id))?;
    if project.is_some_and(|p| p.trusted == Some(true)) {
        for name in ["setup.started", "setup.exit", "setup.log"] {
            match fs::remove_file(holder.dir.join(name)) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
        }
    }
    Ok(())
}

/// Whether the recorded registration is still this checkout's. One that now points at a different
/// checkout is refused while ours is still there, and is someone else's once ours is gone: git
/// reuses a freed registration's name for the next worktree.
pub(super) fn registration(owned: &Owned) -> io::Result<bool> {
    if let Some(admin) = owned.admin.as_deref().filter(|a| Path::new(a).exists()) {
        let gitdir = fs::read_to_string(Path::new(admin).join("gitdir"))?;
        let expected = owned.path.as_deref().map(|p| Path::new(p).join(".git"));
        if expected.as_deref() != Some(Path::new(gitdir.trim_end_matches('\n'))) {
            if owned.path.as_deref().is_some_and(|p| Path::new(p).exists()) {
                return err("The worktree's registration now belongs to another checkout.".into());
            }
            return Ok(false);
        }
    }
    Ok(true)
}
