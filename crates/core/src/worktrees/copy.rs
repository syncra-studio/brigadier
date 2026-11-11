//! The files a new worktree copies from its repository, and what Project settings offers to copy.

use super::{err, git};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::Path;

/// Copies the untracked files that `.worktreeinclude` or the project's picks name and git also
/// ignores [D178, D211]. Links stay links; neither the source nor destination may traverse a
/// linked directory.
pub(super) fn include(repo: &Path, to: &Path, picks: &[String]) -> io::Result<()> {
    for rel in &selected(repo, picks)? {
        let (src, dst) = (repo.join(rel), to.join(rel));
        let parent = dst.parent().unwrap_or(to);
        let existing = parent.ancestors().find(|p| p.exists()).unwrap_or(to);
        if !fs::canonicalize(existing)?.starts_with(fs::canonicalize(to)?)
            || !fs::canonicalize(src.parent().unwrap_or(repo))?.starts_with(fs::canonicalize(repo)?)
        {
            return err(format!("{rel} leaves the worktree or repository"));
        }
        fs::create_dir_all(parent)?;
        let kind = fs::symlink_metadata(&src)?.file_type();
        if kind.is_symlink() {
            std::os::unix::fs::symlink(fs::read_link(&src)?, &dst)?;
        } else if kind.is_file() {
            fs::copy(&src, &dst)?;
        } else {
            return err(format!("{rel} is not a regular file or a symbolic link"));
        }
    }
    Ok(())
}

/// The paths `include` copies from `repo`: named by its rules, and ignored by git.
pub(super) fn selected(repo: &Path, picks: &[String]) -> io::Result<Vec<String>> {
    let mut args = names(repo, picks);
    if args.is_empty() {
        return Ok(vec![]);
    }
    args.splice(
        0..0,
        ["ls-files", "-z", "--others", "--ignored"].map(String::from),
    );
    let named = git(repo, &args.iter().map(String::as_str).collect::<Vec<_>>())?;
    if named.is_empty() {
        return Ok(vec![]);
    }
    let ignored = git(
        repo,
        &[
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-standard",
        ],
    )?;
    let ignored: HashSet<&str> = ignored.split('\0').filter(|p| !p.is_empty()).collect();
    Ok((named.split('\0'))
        .filter(|p| ignored.contains(p))
        .map(String::from)
        .collect())
}

/// Git's rules for what's copied: the repo's own `.worktreeinclude`, and each pick anchored at
/// the repository's top. Empty when nothing is.
fn names(repo: &Path, picks: &[String]) -> Vec<String> {
    let rules = repo.join(".worktreeinclude");
    // Git follows a link when it reads the rules: only a regular file is taken.
    let own = fs::symlink_metadata(&rules).is_ok_and(|m| m.is_file());
    let own = own.then(|| format!("--exclude-from={}", rules.display()));
    own.into_iter()
        .chain(picks.iter().map(|p| format!("--exclude=/{p}")))
        .collect()
}
