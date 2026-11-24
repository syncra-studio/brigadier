//! Remove project's kept branches: deleted at once, and put back for Undo.

use super::{err, git};
use std::io;
use std::path::Path;

/// Each deleted branch with the commit it pointed to.
type Gone = Vec<(String, String)>;

/// A local branch's commit, its name checked strictly first (no `-x`, no `@{-1}`).
fn branch_commit(repo: &Path, name: &str) -> io::Result<String> {
    let full = format!("refs/heads/{name}");
    if name.starts_with('-') || git(repo, &["check-ref-format", &full]).is_err() {
        return err(format!("“{name}” isn't a branch name."));
    }
    git(repo, &["rev-parse", "--verify", "--quiet", &full])
        .or_else(|_| err(format!("No branch {name} in {}.", repo.display())))
}

fn repo_folder(repo: &Path) -> io::Result<()> {
    if !repo.is_absolute() || !repo.is_dir() {
        return err(format!("{} isn't a folder.", repo.display()));
    }
    git(repo, &["rev-parse", "--git-dir"]).map(drop)
}

/// Remove project's Delete N kept branches: each named local branch of `repo` goes, with the commit
/// it pointed to as it went, for Undo. Each on its own: one that's checked out, moved since its
/// commit was read, or gone already is in the errors and the rest still go.
pub fn drop_branches(repo: &Path, names: &[String]) -> io::Result<(Gone, Vec<String>)> {
    repo_folder(repo)?;
    let worktrees = git(repo, &["worktree", "list", "--porcelain"])?;
    let (mut gone, mut failed) = (vec![], vec![]);
    for name in names {
        let full = format!("refs/heads/{name}");
        let dropped = branch_commit(repo, name).and_then(|commit| {
            // As `git branch -D`, never a branch a worktree has checked out.
            if worktrees
                .lines()
                .any(|l| l.strip_prefix("branch ") == Some(full.as_str()))
            {
                return err(format!("{name} is checked out in a worktree."));
            }
            // Only while it still points there, so Undo puts back the commit it really had.
            git(repo, &["update-ref", "-d", &full, &commit])
                .or_else(|_| err(format!("{name} moved while deleting it; it stays.")))?;
            let _ = git(
                repo,
                &["config", "--remove-section", &format!("branch.{name}")],
            );
            Ok(commit)
        });
        match dropped {
            Ok(commit) => gone.push((name.clone(), commit)),
            Err(e) => failed.push(e.to_string()),
        }
    }
    Ok((gone, failed))
}

/// Undo for `drop_branches`: each branch made again at the commit it pointed to; one that can't
/// (made again since) is in the errors and the rest still come back.
pub fn put_branches(repo: &Path, branches: &[(String, String)]) -> io::Result<Vec<String>> {
    repo_folder(repo)?;
    let mut failed = vec![];
    for (name, commit) in branches {
        let hex = matches!(commit.len(), 40 | 64) && commit.bytes().all(|b| b.is_ascii_hexdigit());
        let put = if name.starts_with('-')
            || !hex
            || git(repo, &["check-ref-format", &format!("refs/heads/{name}")]).is_err()
        {
            err(format!("“{name}” at {commit} isn't a branch to put back."))
        } else {
            git(repo, &["branch", name, commit]).map(drop)
        };
        if let Err(e) = put {
            failed.push(e.to_string());
        }
    }
    Ok(failed)
}
