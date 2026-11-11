//! A session's branch renamed and its base changed, in its record [D35, D1021].

use super::{Owned, err, git, has_branch, lock, read, write};
use std::io;
use std::path::{Path, PathBuf};

/// A rename cut short is settled by which name git has: the new one once it's there.
pub(super) fn settled(mut owned: Owned) -> Owned {
    if let Some(new) = owned.renaming.take()
        && has_branch(Path::new(&owned.repo), &new)
    {
        owned.branch = Some(new);
    }
    owned
}

/// Renames the session's branch to `new` [D1021], recorded first so a rename cut short is
/// settled by the next read; its upstream goes, so it's published again under the new name and
/// the old remote branch is left alone (proposed, D1168). Serialised with archive, restore and
/// delete by `lock`.
pub fn rename(dir: &Path, new: &str) -> io::Result<()> {
    let _one = lock(dir)?;
    rename_held(dir, new)
}

/// The title rename holds the session lock before the turn fence and git locks.
pub fn rename_held(dir: &Path, new: &str) -> io::Result<()> {
    let Some(mut owned) = read(dir)? else {
        return err("This session has no branch of its own.".into());
    };
    let Some(old) = owned.branch.clone() else {
        return err("This session has no branch of its own.".into());
    };
    let repo = PathBuf::from(&owned.repo);
    let path = repo.as_path();
    git(path, &["check-ref-format", "--branch", new])
        .or_else(|_| err(format!("{new} isn't a name git takes for a branch.")))?;
    if has_branch(path, new) {
        return err(format!("A branch {new} already exists."));
    }
    owned.renaming = Some(new.into());
    write(dir, &owned)?;
    let renamed = git(path, &["branch", "-m", "--", &old, new]);
    owned.renaming = None;
    if renamed.is_ok() {
        owned.branch = Some(new.into());
    }
    write(dir, &owned)?;
    renamed?;
    // Tracking moved with the name; a branch never published has none.
    let _ = git(path, &["branch", "--unset-upstream", new]);
    Ok(())
}

/// Changes what the session lands into [D1021]: `base` must name a commit in its repository.
pub fn set_base(dir: &Path, base: &str) -> io::Result<()> {
    let _one = lock(dir)?;
    let Some(mut owned) = read(dir)? else {
        return err("This session has no base to change.".into());
    };
    let full = git(
        Path::new(&owned.repo),
        &["rev-parse", "--symbolic-full-name", base],
    )?;
    if owned
        .branch
        .as_ref()
        .is_some_and(|b| full == format!("refs/heads/{b}"))
    {
        return err("A session can't land into its own branch.".into());
    }
    git(
        Path::new(&owned.repo),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{base}^{{commit}}"),
        ],
    )
    .or_else(|_| err(format!("{base} isn't in this project.")))?;
    owned.base = base.into();
    write(dir, &owned)
}
