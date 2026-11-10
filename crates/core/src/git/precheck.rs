//! The land pre-check [D1015, D1049]: `git merge-tree`, which leaves the index and files alone but
//! writes objects, so its result is kept by the commits and tree it merged and runs again only when
//! one changes. Those objects are left to git's own gc as unreferenced loose objects (proposed)
//! [D35]. With it, what stands in the way of a landing in the checkout that has the base [D1047].

use super::{Checkout, err, read};
use crate::adapters::setup;
use crate::worktrees::{self, Lands};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Proposed: a landing's git gives up after this.
const LAND_SECS: u64 = 120;
/// How many pre-check results are kept.
const KEPT: usize = 64;

#[derive(Clone)]
pub(super) enum Merge {
    /// The merged tree.
    Clean(String),
    Conflicts(Vec<String>),
}

/// Pre-check results by base commit, merge base and tree.
static MERGES: Mutex<Vec<([String; 3], Merge)>> = Mutex::new(Vec::new());
static TEMP: AtomicU64 = AtomicU64::new(0);

pub(super) fn git(dir: &Path, args: &[&str], stop: &AtomicBool) -> io::Result<String> {
    Ok(String::from_utf8_lossy(&read(dir, args, stop)?)
        .trim()
        .to_string())
}

/// A git that writes: hooks off unless `hooks`, git's own words on a failure.
pub(super) fn write(
    dir: &Path,
    hooks: bool,
    args: &[&str],
    stop: &AtomicBool,
) -> io::Result<String> {
    let mut command = match hooks {
        true => worktrees::with_hooks(dir),
        false => worktrees::command(dir),
    };
    command.env("PATH", setup::login().path).args(args);
    finish(&mut command, stop)
}

pub(super) fn finish(command: &mut Command, stop: &AtomicBool) -> io::Result<String> {
    let out = setup::run_until(command, LAND_SECS, stop).map_err(io::Error::other)?;
    if !out.status.success() {
        return err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub(super) fn count(dir: &Path, range: &str, stop: &AtomicBool) -> io::Result<u64> {
    git(dir, &["rev-list", "--count", range, "--"], stop)?
        .parse()
        .map_err(io::Error::other)
}

/// Merging `tree` into `base` from `merge_base`, as `git merge-tree` says.
pub(super) fn merge(
    dir: &Path,
    base: &str,
    merge_base: &str,
    tree: &str,
    stop: &AtomicBool,
) -> io::Result<Merge> {
    let key = [base.to_string(), merge_base.to_string(), tree.to_string()];
    if let Some((_, merged)) = MERGES.lock().unwrap().iter().find(|(k, _)| *k == key) {
        return Ok(merged.clone());
    }
    let mut command = worktrees::command(dir);
    command.args([
        "merge-tree",
        "--write-tree",
        "--name-only",
        "-z",
        "--no-messages",
        &format!("--merge-base={merge_base}"),
        base,
        tree,
    ]);
    let out = setup::run_until(&mut command, LAND_SECS, stop).map_err(io::Error::other)?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.split('\0').filter(|p| !p.is_empty());
    let merged = match (out.status.code(), parts.next()) {
        (Some(0), Some(tree)) => Merge::Clean(tree.to_string()),
        (Some(1), Some(_)) => Merge::Conflicts(parts.map(String::from).collect()),
        _ => {
            let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return err(format!("git merge-tree: {why}"));
        }
    };
    let mut kept = MERGES.lock().unwrap();
    if kept.len() >= KEPT {
        kept.remove(0);
    }
    kept.push((key, merged.clone()));
    Ok(merged)
}

/// Removes a scratch file when dropped.
pub(super) struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// The tree the next commit would hold: the staged files, or everything when nothing is, as
/// Commit stages it then. Made in a copy of the index in the session's folder [D35], so the real
/// index and the files are never touched.
pub(super) fn next_tree(
    checkout: &Checkout,
    dir: &Path,
    all: bool,
    stop: &AtomicBool,
) -> io::Result<String> {
    let n = TEMP.fetch_add(1, Ordering::SeqCst);
    let index = Scratch(dir.join(format!("precheck-{}-{n}.index", std::process::id())));
    match fs::copy(checkout.git_dir.join("index"), &index.0) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let run = |args: &[&str]| {
        let mut command = worktrees::command(&checkout.root);
        command.env("GIT_INDEX_FILE", &index.0).args(args);
        finish(&mut command, stop)
    };
    if all {
        run(&["add", "-A"])?;
    }
    run(&["write-tree"])
}

/// Whether a merge or rebase stopped midway in the checkout whose git folder is `git_dir`.
pub(super) fn midway(git_dir: &Path) -> bool {
    ["MERGE_HEAD", "rebase-merge", "rebase-apply"]
        .iter()
        .any(|f| git_dir.join(f).exists())
}

/// The checkouts of the repository: each one's folder and the branch it has, or the branch it's
/// rebasing.
pub(super) fn checkouts(
    dir: &Path,
    stop: &AtomicBool,
) -> io::Result<Vec<(PathBuf, Option<String>)>> {
    let out = read(dir, &["worktree", "list", "--porcelain", "-z"], stop)?;
    let text = String::from_utf8_lossy(&out);
    let mut found = vec![];
    for record in text.split("\0\0").filter(|r| !r.is_empty()) {
        let fields: Vec<&str> = record.split('\0').collect();
        let Some(path) = fields.iter().find_map(|f| f.strip_prefix("worktree ")) else {
            continue;
        };
        let path = PathBuf::from(path);
        if fields.contains(&"bare") || !path.is_dir() {
            continue;
        }
        let branch = fields
            .iter()
            .find_map(|f| f.strip_prefix("branch "))
            .map(String::from)
            .or_else(|| rebasing(&path, stop));
        found.push((path, branch));
    }
    Ok(found)
}

/// The branch a detached checkout is rebasing: it gets that branch back when the rebase ends.
pub(super) fn rebasing(path: &Path, stop: &AtomicBool) -> Option<String> {
    let git_dir = PathBuf::from(git(path, &["rev-parse", "--absolute-git-dir"], stop).ok()?);
    ["rebase-merge/head-name", "rebase-apply/head-name"]
        .iter()
        .find_map(|f| fs::read_to_string(git_dir.join(f)).ok())
        .map(|name| name.trim().to_string())
}

/// The checkout that has `full` (a `refs/heads/` name), if any.
pub(super) fn holder(dir: &Path, full: &str, stop: &AtomicBool) -> io::Result<Option<Checkout>> {
    let Some((path, _)) = (checkouts(dir, stop)?)
        .into_iter()
        .find(|(_, branch)| branch.as_deref() == Some(full))
    else {
        return Ok(None);
    };
    let git_dir = git(&path, &["rev-parse", "--absolute-git-dir"], stop)?;
    Ok(Some(Checkout {
        root: fs::canonicalize(&path)?,
        git_dir: fs::canonicalize(git_dir)?,
        // Used for its folder and lock only, which don't read this.
        worktree: false,
    }))
}

/// The files in `holder` a landing that changes `changed` would run into: edits, untracked and
/// ignored files at those paths or around them.
pub(super) fn collisions(
    holder: &Checkout,
    changed: &[String],
    stop: &AtomicBool,
) -> io::Result<Vec<String>> {
    let args = [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
    ];
    let out = read(&holder.root, &args, stop)?;
    let text = String::from_utf8_lossy(&out);
    let mut records = text.split('\0').filter(|r| r.len() > 3);
    let mut there = vec![];
    while let Some(record) = records.next() {
        there.push(record[3..].trim_end_matches('/').to_string());
        // A rename's old path follows it.
        if matches!(record.as_bytes()[0], b'R' | b'C') {
            records.next();
        }
    }
    let near = |a: &str, b: &str| {
        a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
    };
    let mut hit: Vec<String> = there
        .into_iter()
        .filter(|path| changed.iter().any(|c| near(c, path)))
        .collect();
    hit.sort();
    hit.dedup();
    Ok(hit)
}

/// The paths a landing from `from` to `to` changes.
pub(super) fn changed(
    dir: &Path,
    from: &str,
    to: &str,
    stop: &AtomicBool,
) -> io::Result<Vec<String>> {
    let out = read(
        dir,
        &["diff", "--name-only", "--no-renames", "-z", from, to],
        stop,
    )?;
    Ok(String::from_utf8_lossy(&out)
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect())
}

/// The base's full ref name: landing goes only into a local branch.
pub(super) fn full_name(dir: &Path, base: &str, stop: &AtomicBool) -> String {
    git(dir, &["rev-parse", "--symbolic-full-name", base], stop).unwrap_or_default()
}

/// Why the base can't take a landing now, or null [D1047, D1161].
pub(super) fn blocked(
    dir: &Path,
    base: &str,
    from: &str,
    tree: &str,
    stop: &AtomicBool,
) -> io::Result<Value> {
    let full = full_name(dir, base, stop);
    if full.starts_with("refs/remotes/") {
        return Ok(json!({"why": "remote"}));
    }
    if !full.starts_with("refs/heads/") {
        return Ok(json!({"why": "commit"}));
    }
    let Some(holder) = holder(dir, &full, stop)? else {
        return Ok(Value::Null);
    };
    if midway(&holder.git_dir) {
        return Ok(json!({"why": "midway", "folder": holder.root}));
    }
    let files = collisions(&holder, &changed(dir, from, tree, stop)?, stop)?;
    Ok(match files.is_empty() {
        true => Value::Null,
        false => json!({"why": "busy", "folder": holder.root, "files": files}),
    })
}

/// What `head` merges into `base` from: git's merge base, or after a squash still in the base,
/// the HEAD it squashed, so only the work since then merges, not the squashed commits again.
pub(super) fn merge_base(
    dir: &Path,
    lands: &Lands,
    base: &str,
    head: &str,
    stop: &AtomicBool,
) -> io::Result<String> {
    let ancestor =
        |a: &str, b: &str| read(dir, &["merge-base", "--is-ancestor", a, b], stop).is_ok();
    match &lands.landing {
        Some(l) if l.style == "squash" && ancestor(&l.commit, base) && ancestor(&l.head, head) => {
            Ok(l.head.clone())
        }
        _ => git(dir, &["merge-base", base, head], stop),
    }
}

/// The session that keeps landing while it shares this one's folder [D1082].
// shortcut: no session shares a folder until 2.35 (stream O); then this reads O's `share::lands`.
pub(super) fn shared_with(_data: &Path, _id: &str) -> Option<String> {
    None
}
