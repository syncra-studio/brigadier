//! A free's checkpoint [D180]: the worktree's changes, those in repositories it holds too, committed
//! to its branch.

use super::{Owned, branch, err, git, inner};
use std::io;
use std::path::Path;

/// Commits what changed in `path`, `owned`'s worktree; on another branch or none, nothing, and why
/// if it has changes or commits on no branch. Clean there, it has nothing to keep: its commits stay.
pub(super) fn commit(owned: &Owned, path: &Path) -> io::Result<()> {
    // None: a detached HEAD.
    let branch = branch::at(path).ok();
    let held = inner::held(path)?;
    if branch.as_ref() != owned.branch.as_ref() {
        let on = branch.unwrap_or_else(|| "a detached HEAD".into());
        let status = ["status", "--porcelain", "-z", "--untracked-files=all", "--"].into_iter();
        let status: Vec<&str> = status.chain(held.iter().map(String::as_str)).collect();
        if !git(path, &status)?.is_empty() {
            return err(format!(
                "The worktree is on {on} with uncommitted changes; commit them or switch back first."
            ));
        }
        // Detached, its commits on no branch would go with the worktree.
        let loose = [
            "rev-list",
            "-n1",
            "HEAD",
            "--not",
            "--branches",
            "--tags",
            "--remotes",
        ];
        if !git(path, &loose)?.is_empty() {
            return err(format!(
                "The worktree is on {on} with commits on no branch; branch them or switch back first."
            ));
        }
        return Ok(());
    }
    let add = ["add", "-A", "--"].into_iter();
    git(
        path,
        &add.chain(held.iter().map(String::as_str))
            .collect::<Vec<_>>(),
    )?;
    if !git(path, &["diff", "--cached", "--name-only", "-z"])?.is_empty() {
        git(
            path,
            &[
                "commit",
                "--quiet",
                "--no-verify",
                "-m",
                "Brigadier checkpoint",
            ],
        )?;
    }
    Ok(())
}
