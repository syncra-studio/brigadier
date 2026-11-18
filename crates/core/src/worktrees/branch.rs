//! A session's branch renamed in its record [D35, D1021], and a PR's fetched to work on [D674].

use super::{Owned, err, git, has_branch, read, write};
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

/// Fetches PR `number`'s branch `head` from `origin` for a session to work on [D674]: its own name,
/// tracking the host's so a push updates the PR, kept as it is when it's here already. A `fork`'s
/// PR comes by its number as `pr-<number>`, whose pushes don't reach the fork.
pub fn fetch_pr(repo: &Path, number: u64, head: &str, fork: bool) -> io::Result<String> {
    if fork {
        let local = format!("pr-{number}");
        let spec = format!("refs/pull/{number}/head:refs/heads/{local}");
        git(repo, &["fetch", "--quiet", "origin", &spec])?;
        return Ok(local);
    }
    let spec = format!("+refs/heads/{head}:refs/remotes/origin/{head}");
    git(repo, &["fetch", "--quiet", "origin", &spec])?;
    if !has_branch(repo, head) {
        let from = format!("origin/{head}");
        git(repo, &["branch", "--quiet", "--track", head, &from])?;
    }
    Ok(head.into())
}
