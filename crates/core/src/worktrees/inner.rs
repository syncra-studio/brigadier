//! Repositories inside a folder, whose work git outside them doesn't hold: a commit out there takes
//! no more of one than a link to its own commit.

use super::{command, git};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Each repository in `dir`, itself too, the outermost ones; not looked for in `skip`. A folder that
/// can't be read counts as one. `one`: the first is enough.
fn walk(dir: &Path, skip: &[PathBuf], one: bool) -> Vec<PathBuf> {
    let (mut stack, mut found) = (vec![dir.to_path_buf()], vec![]);
    while let Some(next) = stack.pop() {
        if one && !found.is_empty() {
            break;
        }
        let entries = match fs::read_dir(&next) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => {
                found.push(next);
                continue;
            }
        };
        // A bare one has no `.git`.
        let mut repo = next.join("HEAD").is_file() && next.join("objects").is_dir();
        let mut below = vec![];
        for entry in entries {
            let Ok(entry) = entry else {
                repo = true;
                break;
            };
            let path = entry.path();
            if skip.contains(&path) {
                continue;
            }
            if entry.file_name() == ".git" {
                repo = true;
                break;
            }
            if entry.file_type().map_or(true, |t| t.is_dir()) {
                below.push(path);
            }
        }
        match repo {
            true => found.push(next),
            false => stack.extend(below),
        }
    }
    found.sort();
    found
}

/// Each repository in `dir`, the outermost ones, looked for anywhere but in `skip`.
pub fn repos(dir: &Path, skip: &[PathBuf]) -> Vec<PathBuf> {
    walk(dir, skip, false)
}

/// Whether there is one.
pub fn repo_inside(dir: &Path, skip: &[PathBuf]) -> bool {
    !walk(dir, skip, true).is_empty()
}

/// Whether the repository at `path` has a commit: git refuses to add one that has none.
pub fn has_commit(path: &Path) -> bool {
    let mut command = command(path);
    command.args(["rev-parse", "--verify", "--quiet", "HEAD"]);
    command.output().is_ok_and(|o| o.status.success())
}

/// The worktree as a checkpoint takes it: all but the untracked repositories in it, of which it would
/// hold a link to nothing.
pub(super) fn held(path: &Path) -> io::Result<Vec<String>> {
    let others = git(path, &["ls-files", "-z", "--others", "--exclude-standard"])?;
    // Only a repository comes as a folder.
    let inner = others.split('\0').filter_map(|rel| rel.strip_suffix('/'));
    let but = inner.map(|rel| format!(":(exclude,literal){rel}"));
    Ok([":/".into()].into_iter().chain(but).collect())
}
