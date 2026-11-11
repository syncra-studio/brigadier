//! Catch up with main (2.50) [D1286]: one click merges the session's base into its branch, in its
//! own worktree, as a merge commit. The pre-check runs first: a merge that would conflict changes
//! nothing and the control offers Resolve with agent instead [D1093, D1290]; one that conflicts
//! after all (the base moved past the check) is aborted, the files as they were [D1166].

use super::precheck::{Merge, git, merge, midway};
use super::{Target, checkout, lock, read};
use crate::{session_dir, worktrees};
use std::io;
use std::path::Path;
use std::sync::atomic::AtomicBool;

const CONFLICTS: &str = "Catching up would conflict with this branch's commits.";

fn err<T>(message: impl Into<String>) -> io::Result<T> {
    Err(io::Error::other(message.into()))
}

/// Merges the base, pinned to the commits the control was worked out on (`head`, `base_at`), into
/// session `id`'s branch. The caller holds the session's `worktrees::lock` across it, taken before
/// any checkout lock, as a turn start does [D1235].
pub fn catch_up(
    data: &Path,
    id: &str,
    (head, base_at): (&str, &str),
    stop: &AtomicBool,
) -> io::Result<()> {
    // Catching up moves the branch: the session that lands does it [D1082].
    if let Some(with) = super::precheck::shared_with(data, id) {
        return err(format!("Catching up stays with {with}."));
    }
    let dir = session_dir(data, id);
    let Some(lands) = worktrees::lands(&dir)? else {
        return err("This session has no base to catch up with.");
    };
    let session = checkout(data, &Target::Session(id))?;
    let root = &session.root;
    let _held = lock(&session, true, stop)?;
    let dirty = read(
        root,
        &["status", "--porcelain", "-z", "--untracked-files=all"],
        stop,
    )?;
    if !dirty.is_empty() || midway(&session.git_dir) {
        return err("This session has changes that aren't committed. Commit them first.");
    }
    let now = git(root, &["rev-parse", "--verify", "HEAD^{commit}"], stop)?;
    let base_now = git(
        root,
        &[
            "rev-parse",
            "--verify",
            &format!("{}^{{commit}}", lands.base),
        ],
        stop,
    )?;
    if now != head || base_now != base_at {
        return err("The branch or its base moved since. Look again.");
    }
    let merge_base = git(root, &["merge-base", head, base_at], stop)?;
    let tree = git(root, &["rev-parse", &format!("{head}^{{tree}}")], stop)?;
    if let Merge::Conflicts(_) = merge(root, base_at, &merge_base, &tree, stop)? {
        return err(CONFLICTS);
    }
    let message = format!(
        "Merge {} into {}",
        lands.base,
        super::sync::branch(&session)?
    );
    // Never over an ignored file of the user's, never with a stash of its own [D35].
    let args = [
        "-c",
        "merge.autoStash=false",
        "merge",
        "--no-ff",
        "--no-autostash",
        "--no-overwrite-ignore",
        "--no-edit",
        "-m",
        &message,
        base_at,
    ];
    match git(root, &args, stop) {
        Ok(_) => Ok(()),
        Err(_) if session.git_dir.join("MERGE_HEAD").exists() => {
            let _ = git(root, &["merge", "--abort"], stop);
            err(CONFLICTS)
        }
        Err(e) => err(format!("The merge didn't go through.\n\n{e}")),
    }
}
