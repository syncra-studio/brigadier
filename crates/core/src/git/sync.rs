//! The branch item's sync [D1020]: pull then push, keeping the branch's own remote, destination and
//! tracking; and auto-fetch of every published branch [D1026]. Git does the work.

use super::push::{self, push_held};
use super::{Checkout, Target, checkout, lock, read};
use crate::adapters::setup;
use crate::{ids, load, projects, session_dir, worktrees};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

// Unknown after a daemon restart; a failed fetch never advances a successful fetch's time.
static FETCHED: Mutex<BTreeMap<(PathBuf, String), u64>> = Mutex::new(BTreeMap::new());

fn common(checkout: &Checkout) -> Option<PathBuf> {
    let out = read(
        &checkout.root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        &AtomicBool::new(false),
    )
    .ok()?;
    fs::canonicalize(String::from_utf8_lossy(&out).trim()).ok()
}

pub fn fetched_at(checkout: &Checkout, remote: &str) -> Option<u64> {
    let common = common(checkout)?;
    FETCHED
        .lock()
        .unwrap()
        .get(&(common, remote.into()))
        .copied()
}

/// Proposed: a pull or fetch gives up after this.
const NET_SECS: u64 = 120;

fn err<T>(message: impl Into<String>) -> io::Result<T> {
    Err(io::Error::other(message.into()))
}

/// Whether the checkout's project is trusted, so its own hooks run on a push or pull [D166, D211].
pub fn trusted(data: &Path, target: &Target) -> bool {
    let project = match target {
        Target::Session(id) => load(data, id).ok().and_then(|s| s.project),
        Target::Project(id) => Some(id.to_string()),
    };
    project.is_some_and(|p| projects::get(data, &p).is_ok_and(|p| p.trusted == Some(true)))
}

pub(super) fn config(checkout: &Checkout, key: &str) -> Option<String> {
    read(
        &checkout.root,
        &["config", "--get", key],
        &AtomicBool::new(false),
    )
    .ok()
    .map(|out| String::from_utf8_lossy(&out).trim().to_string())
    .filter(|value| !value.is_empty())
}

/// The checked-out branch.
pub fn branch(checkout: &Checkout) -> io::Result<String> {
    let out = read(
        &checkout.root,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        &AtomicBool::new(false),
    )
    .or_else(|_| err("This checkout isn't on a branch."))?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// Git in the checkout with the network's settings: never a prompt, and the trusted project's hooks.
fn net(checkout: &Checkout, hooks: bool) -> std::process::Command {
    let mut command = match hooks {
        true => worktrees::with_hooks(&checkout.root),
        false => worktrees::command(&checkout.root),
    };
    command
        .env("PATH", setup::login().path)
        .env("GCM_INTERACTIVE", "never");
    command
}

fn run(mut command: std::process::Command, stop: &AtomicBool) -> io::Result<()> {
    let out = setup::run_until(&mut command, NET_SECS, stop).map_err(io::Error::other)?;
    match out.status.success() {
        true => Ok(()),
        false => err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
    }
}

/// Fetches `remote` quietly.
fn fetch(checkout: &Checkout, remote: &str, stop: &AtomicBool) -> io::Result<()> {
    let mut command = net(checkout, false);
    command.args(["fetch", "--quiet", "--", remote]);
    run(command, stop)?;
    if let Some(common) = common(checkout) {
        FETCHED
            .lock()
            .unwrap()
            .insert((common, remote.into()), brigadier_frames::log::now_ms());
    }
    Ok(())
}

/// Pull then push, as VS Code's Sync [D1020]: the branch's own upstream (its remote and branch) is
/// pulled and pushed to, and its tracking stays. A pull that would conflict changes nothing and
/// says so, until 2.23's conflict tab (proposed, D1166). The checkout's lock is held throughout,
/// so no switch changes the branch under it.
pub fn sync(checkout: &Checkout, hooks: bool, stop: &AtomicBool) -> io::Result<()> {
    let _held = lock(checkout, true, stop)?;
    let git_dir = &checkout.git_dir;
    let stopped = [
        "MERGE_HEAD",
        "rebase-merge",
        "rebase-apply",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
    ];
    if stopped.iter().any(|name| git_dir.join(name).exists()) {
        return err("A merge or rebase is under way here. Finish or abort it before syncing.");
    }
    let branch = branch(checkout)?;
    let (Some(remote), Some(dest)) = (
        config(checkout, &format!("branch.{branch}.remote")),
        config(checkout, &format!("branch.{branch}.merge")),
    ) else {
        return err("This branch isn't published yet.");
    };
    if remote == "." {
        return err("This branch follows a local branch, so there's nothing to sync.");
    }
    fetch(checkout, &remote, stop)
        .map_err(|e| io::Error::other(format!("Couldn't reach the remote.\n\n{e}")))?;
    let counts = |stop: &AtomicBool| -> io::Result<(u64, u64)> {
        let out = read(
            &checkout.root,
            &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
            stop,
        )?;
        let text = String::from_utf8_lossy(&out);
        let mut n = text.split_whitespace().map(|n| n.parse().unwrap_or(0));
        Ok((n.next().unwrap_or(0), n.next().unwrap_or(0)))
    };
    let (ahead, behind) = counts(stop)?;
    if behind > 0 {
        pull(checkout, &branch, ahead > 0, hooks, stop)?;
    }
    if counts(stop)?.0 > 0 {
        push_held(checkout, &remote, &branch, &dest, &[], hooks, stop)?;
    }
    Ok(())
}

/// Push only, to the branch's own upstream (its remote and branch), its tracking kept: the control's
/// Push [D1285]. A remote with commits this branch doesn't have turns it away; Sync is the fix.
pub fn push(checkout: &Checkout, hooks: bool, stop: &AtomicBool) -> io::Result<()> {
    let branch = branch(checkout)?;
    let (Some(remote), Some(dest)) = (
        config(checkout, &format!("branch.{branch}.remote")),
        config(checkout, &format!("branch.{branch}.merge")),
    ) else {
        return err("This branch isn't published yet.");
    };
    if remote == "." {
        return err("This branch follows a local branch, so there's nowhere to push.");
    }
    push::push_to(checkout, &remote, &branch, &dest, &[], hooks, stop)
}

const CONFLICTS: &str = "Pulling would conflict with this branch's commits.";

fn pull(
    checkout: &Checkout,
    branch: &str,
    diverged: bool,
    hooks: bool,
    stop: &AtomicBool,
) -> io::Result<()> {
    // Asked before anything moves: merge-tree writes no file, index or ref [D1166].
    if diverged {
        let mut command = worktrees::command(&checkout.root);
        command.args([
            "merge-tree",
            "--write-tree",
            "--name-only",
            "HEAD",
            "@{upstream}",
        ]);
        let out = setup::run_until(&mut command, NET_SECS, stop).map_err(io::Error::other)?;
        match out.status.code() {
            Some(0) => {}
            Some(1) => return err(CONFLICTS),
            _ => return err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        }
    }
    let mut command = net(checkout, hooks);
    command.args(["pull", "--quiet", "--no-edit"]);
    // The user's own choice stands; with none, a merge, as git's own default was.
    if config(checkout, "pull.rebase").is_none()
        && config(checkout, &format!("branch.{branch}.rebase")).is_none()
    {
        command.arg("--no-rebase");
    }
    let pulled = run(command, stop);
    if pulled.is_ok() {
        return Ok(());
    }
    // Stopped half-way after all (none was under way at the start): undone, the user's own edits
    // as they were.
    let git_dir = &checkout.git_dir;
    let undo = match () {
        _ if git_dir.join("MERGE_HEAD").exists() => Some("merge"),
        _ if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() => {
            Some("rebase")
        }
        _ => None,
    };
    if let Some(undo) = undo {
        let mut command = worktrees::command(&checkout.root);
        command.args([undo, "--abort"]);
        let _ = run(command, stop);
        return err(CONFLICTS);
    }
    pulled.map_err(|e| io::Error::other(format!("The pull didn't go through.\n\n{e}")))
}

/// Publish [D1020]: the branch to the same name on the remote git would push to, tracked there.
pub fn publish(checkout: &Checkout, hooks: bool, stop: &AtomicBool) -> io::Result<()> {
    let branch = branch(checkout)?;
    let remote = push::remote(checkout, &branch)?;
    push::push(checkout, &remote, &branch, hooks, stop)
}

/// Auto-fetch [D1026]: each remote a published branch follows, once per repository, every session's
/// and project's. A remote that fails is logged and left, so the counts stay as they were.
pub fn fetch_published(data: &Path, stop: &AtomicBool) {
    let mut checkouts = vec![];
    for id in ids(data) {
        if !session_dir(data, &id).join("archived").exists() {
            checkouts.extend(checkout(data, &Target::Session(&id)).ok());
        }
    }
    for project in projects::list(data).unwrap_or_default() {
        checkouts.extend(checkout(data, &Target::Project(&project.id)).ok());
    }
    let mut done = BTreeSet::<(PathBuf, String)>::new();
    for checkout in checkouts {
        let Ok(branch) = branch(&checkout) else {
            continue;
        };
        let Some(remote) = config(&checkout, &format!("branch.{branch}.remote")) else {
            continue;
        };
        let common = read(
            &checkout.root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            stop,
        )
        .ok()
        .and_then(|out| fs::canonicalize(String::from_utf8_lossy(&out).trim()).ok());
        let Some(common) = common.filter(|_| remote != ".") else {
            continue;
        };
        if done.insert((common, remote.clone()))
            && let Err(e) = fetch(&checkout, &remote, stop)
        {
            eprintln!(
                "brigadier: fetching {remote} in {}: {e}",
                checkout.root.display()
            );
        }
    }
}
