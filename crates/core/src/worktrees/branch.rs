//! A session's branch renamed in its record [D35, D1021].

use super::{Owned, err, git, read, write};
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
/// the old remote branch is left alone (proposed, D1168). The title rename holds the session lock
/// before the turn fence and git locks.
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

/// The branch checked out in `path`; git's own short name isn't it beside a tag of that name.
pub(super) fn at(path: &Path) -> io::Result<String> {
    let full = git(path, &["symbolic-ref", "--quiet", "HEAD"])?;
    Ok(full.strip_prefix("refs/heads/").unwrap_or(&full).into())
}

/// Whether the branch exists in the repository.
pub(super) fn has_branch(repo: &Path, branch: &str) -> bool {
    git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok()
}
