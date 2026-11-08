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
    let mut args = names(repo, picks);
    if args.is_empty() {
        return Ok(());
    }
    args.splice(
        0..0,
        ["ls-files", "-z", "--others", "--ignored"].map(String::from),
    );
    let named = git(repo, &args.iter().map(String::as_str).collect::<Vec<_>>())?;
    if named.is_empty() {
        return Ok(());
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
    for rel in named.split('\0').filter(|p| ignored.contains(p)) {
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

/// What Project settings offers to copy [D178]: the ignored, untracked entries in `dir` (the
/// repository's top for ""), a wholly ignored folder as one entry ending in `/`, at most
/// `MAX_LISTED`; and those the repo's own `.worktreeinclude` already copies.
pub fn ignored(repo: &Path, dir: &str) -> io::Result<(Vec<String>, Vec<String>)> {
    let list = |rules: &str| {
        let mut args = vec![
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--directory",
            rules,
        ];
        if !dir.is_empty() {
            args.extend(["--", dir]);
        }
        let out = git(repo, &args)?;
        let all = out
            .split('\0')
            .filter(|p| !p.is_empty() && p.trim_end_matches('/') != dir.trim_end_matches('/'));
        Ok::<_, io::Error>(all.take(MAX_LISTED).map(String::from).collect::<Vec<_>>())
    };
    let mut entries = list("--exclude-standard")?;
    // A wholly ignored folder lists as itself: its own entries come from the disk.
    if entries.is_empty() && !dir.is_empty() {
        let at = repo.join(dir);
        for entry in fs::read_dir(&at)?.flatten().take(MAX_LISTED) {
            let kind = entry.file_type()?;
            let slash = if kind.is_dir() { "/" } else { "" };
            entries.push(format!(
                "{}/{}{slash}",
                dir.trim_end_matches('/'),
                entry.file_name().to_string_lossy()
            ));
        }
        entries.sort();
    }
    let own = names(repo, &[]);
    let copied = match own.first() {
        Some(rules) => list(rules)?,
        None => vec![],
    };
    Ok((entries, copied))
}

/// Proposed: Project settings lists at most this many entries per folder.
const MAX_LISTED: usize = 300;
