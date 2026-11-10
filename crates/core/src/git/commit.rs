//! A commit from Source's message field [D1029, D1107], under the checkout's lock [D1060]. What it
//! commits is fixed before the message is written: `prepare` reads the tree it will commit (the
//! index, or with `all` everything, staged in a copy of the index so nothing moves yet) and the HEAD
//! it goes on. `commit` refuses if either moved since, so the message always fits what lands.

use super::{Checkout, err, lock, read};
use crate::adapters::setup;
use crate::worktrees;
use std::fs;
use std::io;
use std::process::Command;
use std::sync::atomic::AtomicBool;

/// Git's empty tree, the base of a repository's first commit.
const EMPTY: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/// Proposed: a commit, its hooks included, gives up after this.
const COMMIT_SECS: u64 = 120;

/// What a commit will hold: the HEAD it goes on (None in a repository with no commit yet), its
/// tree, and that tree's changes as a patch for the writer.
pub struct Prepared {
    pub head: Option<String>,
    pub tree: String,
    pub patch: String,
}

fn text(out: Vec<u8>) -> String {
    String::from_utf8_lossy(&out).trim().to_string()
}

fn head(checkout: &Checkout, stop: &AtomicBool) -> Option<String> {
    read(
        &checkout.root,
        &["rev-parse", "--verify", "-q", "HEAD"],
        stop,
    )
    .ok()
    .map(text)
}

/// Runs `command`, refusing in one sentence with git's own words after it.
fn run(command: &mut Command, what: &str, stop: &AtomicBool) -> io::Result<String> {
    let out = setup::run_until(command, COMMIT_SECS, stop).map_err(io::Error::other)?;
    if out.status.success() {
        return Ok(text(out.stdout));
    }
    let said = [out.stderr, out.stdout].map(text);
    let why = said
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>();
    err(format!("{what}\n\n{}", why.join("\n")))
}

/// The tree the index holds; with `all`, the tree once every change is staged, read from a copy
/// of the index so the real one is untouched until the commit.
fn tree(checkout: &Checkout, all: bool, stop: &AtomicBool) -> io::Result<String> {
    let mut write_tree = worktrees::command(&checkout.root);
    write_tree.arg("write-tree");
    if !all {
        return run(&mut write_tree, "Resolve the conflicts first.", stop);
    }
    let copy = std::env::temp_dir().join(format!("brigadier-index-{}", crate::adapters::uuid()));
    let index = checkout.git_dir.join("index");
    if index.exists() {
        fs::copy(&index, &copy)?;
    }
    let mut add = worktrees::command(&checkout.root);
    add.env("GIT_INDEX_FILE", &copy).args(["add", "-A"]);
    write_tree.env("GIT_INDEX_FILE", &copy);
    let made = run(&mut add, "Couldn't stage the changes.", stop)
        .and_then(|_| run(&mut write_tree, "Resolve the conflicts first.", stop));
    let _ = fs::remove_file(&copy);
    made
}

/// What a commit of the index (or with `all`, of every change) would hold, read under the lock.
pub fn prepare(checkout: &Checkout, all: bool, stop: &AtomicBool) -> io::Result<Prepared> {
    let _held = lock(checkout, false, stop)?;
    let head = head(checkout, stop);
    let tree = tree(checkout, all, stop)?;
    let base = head.as_deref().unwrap_or(EMPTY);
    let patch = read(
        &checkout.root,
        &[
            "diff-tree",
            "--patch-with-stat",
            "-M",
            "--no-color",
            base,
            &tree,
        ],
        stop,
    )?;
    if patch.is_empty() {
        return err("There's nothing to commit.");
    }
    Ok(Prepared {
        head,
        tree,
        patch: String::from_utf8_lossy(&patch).into_owned(),
    })
}

/// Commits `prepared` with `message`, unless the HEAD or the changes moved since it was read: then
/// nothing is committed and the user commits again. `hooks`: the project is trusted, so its own
/// commit hooks run [D166]. The new commit's id.
pub fn commit(
    checkout: &Checkout,
    prepared: &Prepared,
    all: bool,
    message: &str,
    hooks: bool,
    stop: &AtomicBool,
) -> io::Result<String> {
    let message = message.trim();
    if message.is_empty() {
        return err("Type a message to commit with.");
    }
    let _held = lock(checkout, true, stop)?;
    let moved = || err("The changes moved while the message was written. Commit again.");
    if head(checkout, stop) != prepared.head {
        return moved();
    }
    // Checked on a copy of the index first, so a refusal leaves the real one as it was.
    if all && tree(checkout, true, stop)? != prepared.tree {
        return moved();
    }
    if all {
        let mut add = worktrees::command(&checkout.root);
        add.args(["add", "-A"]);
        run(&mut add, "Couldn't stage the changes.", stop)?;
    }
    let mut write_tree = worktrees::command(&checkout.root);
    write_tree.arg("write-tree");
    if run(&mut write_tree, "Resolve the conflicts first.", stop)? != prepared.tree {
        return moved();
    }
    let mut command = match hooks {
        true => worktrees::with_hooks(&checkout.root),
        false => worktrees::command(&checkout.root),
    };
    // The login shell's PATH, so a hook finds its tools when the app was opened from Finder.
    command.env("PATH", setup::login().path).args([
        "commit",
        "--quiet",
        "--cleanup=whitespace",
        "-m",
        message,
    ]);
    run(&mut command, "The commit didn't go through.", stop)?;
    head(checkout, stop).map_or_else(|| err("The commit didn't go through."), Ok)
}

/// The latest `n` commit subjects, newest first: the repository's style for the writer.
pub fn subjects(checkout: &Checkout, n: usize, stop: &AtomicBool) -> Vec<String> {
    let count = format!("-n{n}");
    (read(
        &checkout.root,
        &["log", &count, "--no-merges", "--format=%s"],
        stop,
    )
    .ok())
    .map(|out| {
        String::from_utf8_lossy(&out)
            .lines()
            .map(String::from)
            .collect()
    })
    .unwrap_or_default()
}

/// The branch since `base`: its commits' subjects, oldest first, and its changes as one patch,
/// what a PR or a squash holds.
pub fn branch(
    checkout: &Checkout,
    base: &str,
    stop: &AtomicBool,
) -> io::Result<(Vec<String>, String)> {
    let range = format!("{base}..HEAD");
    let out = read(
        &checkout.root,
        &["log", "--reverse", "--format=%s", &range, "--"],
        stop,
    )?;
    let commits = String::from_utf8_lossy(&out)
        .lines()
        .map(String::from)
        .collect();
    let since = format!("{base}...HEAD");
    let patch = read(
        &checkout.root,
        &[
            "diff",
            "--patch-with-stat",
            "-M",
            "--no-color",
            &since,
            "--",
        ],
        stop,
    )?;
    Ok((commits, String::from_utf8_lossy(&patch).into_owned()))
}
