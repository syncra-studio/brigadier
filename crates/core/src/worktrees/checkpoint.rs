//! A free's checkpoint [D180]: the worktree's changes, those in repositories it holds too, committed
//! to its branch.

use super::{Owned, branch, err, git, inner};
use std::io;
use std::path::Path;

/// Commits what changed in `path`, `owned`'s worktree; on another branch, nothing, and why if it
/// has changes. Clean there, it has nothing to keep: its commits stay on that branch.
pub(super) fn commit(owned: &Owned, path: &Path) -> io::Result<()> {
    let branch = branch::at(path)?;
    let held = inner::held(path)?;
    if Some(&branch) != owned.branch.as_ref() {
        let status = ["status", "--porcelain", "-z", "--"].into_iter();
        let status: Vec<&str> = status.chain(held.iter().map(String::as_str)).collect();
        if git(path, &status)?.is_empty() {
            return Ok(());
        }
        return err(format!(
            "The worktree is on {branch} with uncommitted changes; commit them or switch back first."
        ));
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
