//! A free's checkpoint [D180]: the worktree's changes, those in repositories it holds too, committed
//! to its branch.

use super::{Owned, branch, err, git, inner};
use std::io;
use std::path::Path;

/// Commits what changed in `path`, `owned`'s worktree; on another branch, nothing, and why.
pub(super) fn commit(owned: &Owned, path: &Path) -> io::Result<()> {
    let branch = branch::at(path)?;
    if Some(&branch) != owned.branch.as_ref() {
        return err("The worktree is on another branch; switch back first.".into());
    }
    let held = inner::held(path)?;
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
