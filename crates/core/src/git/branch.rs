//! The branch item's quick pick [D1020, D1021]: what it lists, and its moves. A session's own branch
//! never switches, its pick only copies [D62]; only a folder of the user's own (a Local checkout,
//! the project folder) switches or makes branches, never while an agent works in it.

use super::{Checkout, Target, folder, lock, read};
use crate::{ids, session_dir, worktrees};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::AtomicBool;

fn err<T>(message: impl Into<String>) -> io::Result<T> {
    Err(io::Error::other(message.into()))
}

/// What the folder's quick pick shows: the branches, newest first.
pub fn branches(checkout: &Checkout) -> io::Result<Value> {
    let stop = AtomicBool::new(false);
    let out = read(
        &checkout.root,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)%00%(symref)%00%(committerdate:unix)%00%(authorname)%00%(subject)",
            "refs/heads",
            "refs/remotes",
        ],
        &stop,
    )?;
    let text = String::from_utf8_lossy(&out);
    let branches: Vec<Value> = (text.lines())
        .filter_map(|line| {
            let [name, symref, at, author, subject] = line.split('\0').collect::<Vec<_>>()[..]
            else {
                return None;
            };
            let (name, remote) = match name.strip_prefix("refs/heads/") {
                Some(local) => (local, false),
                None => (name.strip_prefix("refs/remotes/")?, true),
            };
            // A remote's HEAD only points at one of its branches.
            (symref.is_empty()).then(|| {
                json!({"name": name, "remote": remote, "atMs": at.parse::<u64>().unwrap_or(0) * 1000,
                    "author": author, "subject": subject})
            })
        })
        .collect();
    Ok(json!({"branches": branches}))
}

/// The sessions that work in this checkout, a subfolder of it included: none may have their branch
/// switched from under them while busy [D1021, D1082]. Only a folder of the user's own asks.
pub fn sharing(data: &Path, checkout: &Checkout) -> Vec<String> {
    (ids(data).into_iter())
        .filter(|id| !session_dir(data, id).join("archived").exists())
        .filter(|id| {
            // Found without git first: only one under this checkout's folder is asked.
            folder(data, &Target::Session(id))
                .and_then(fs::canonicalize)
                .is_ok_and(|f| f.starts_with(&checkout.root))
                && super::checkout(data, &Target::Session(id))
                    .is_ok_and(|c| c.root == checkout.root)
        })
        .collect()
}

/// The fence a switch holds: no turn starts in a shared folder meanwhile [D172, D1082].
pub fn fence(data: &Path) -> io::Result<fs::File> {
    crate::rewind::checkout_lock(data, true)
}

fn folder_only(checkout: &Checkout) -> io::Result<()> {
    match checkout.worktree {
        true => err("This session works on its own branch, so it doesn't switch."),
        false => Ok(()),
    }
}

fn git(checkout: &Checkout, args: &[&str], stop: &AtomicBool) -> io::Result<()> {
    let _held = lock(checkout, true, stop)?;
    let mut command = worktrees::command(&checkout.root);
    command.args(args);
    let out =
        crate::adapters::setup::run_until(&mut command, 60, stop).map_err(io::Error::other)?;
    match out.status.success() {
        true => Ok(()),
        false => err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
    }
}

fn check_name(checkout: &Checkout, name: &str) -> io::Result<()> {
    let ok = read(
        &checkout.root,
        &["check-ref-format", "--branch", name],
        &AtomicBool::new(false),
    );
    match ok.is_ok() && !name.starts_with('-') {
        true => Ok(()),
        false => err(format!("{name} isn't a name git takes for a branch.")),
    }
}

/// Switches a folder to `name`: a local branch, or a remote one (`origin/x`) as a new local
/// branch following it, as VS Code does [D1021]. The caller holds `fence` and found no one busy.
pub fn switch(checkout: &Checkout, name: &str, remote: bool, stop: &AtomicBool) -> io::Result<()> {
    folder_only(checkout)?;
    if name.starts_with('-') {
        return err(format!("No branch {name}."));
    }
    match remote {
        true => git(checkout, &["switch", "--quiet", "--track", name], stop),
        false => git(checkout, &["switch", "--quiet", name], stop),
    }
}

/// Commits everything changed in the folder as `message` [D168]; false when there was nothing.
pub fn commit_all(checkout: &Checkout, message: &str, stop: &AtomicBool) -> io::Result<bool> {
    let changed = read(&checkout.root, &["status", "--porcelain"], stop)?;
    if changed.is_empty() {
        return Ok(false);
    }
    git(checkout, &["add", "-A"], stop)?;
    git(checkout, &["commit", "--quiet", "-m", message], stop)?;
    Ok(true)
}

/// Pushes `branch` to `remote` when it has no upstream or is ahead of it, setting it as the
/// upstream [D168]; false when there was nothing to push.
pub fn push(
    checkout: &Checkout,
    remote: &str,
    branch: &str,
    stop: &AtomicBool,
) -> io::Result<bool> {
    let ahead = read(
        &checkout.root,
        &["rev-list", "--count", "@{upstream}..HEAD"],
        stop,
    );
    if ahead.is_ok_and(|n| String::from_utf8_lossy(&n).trim() == "0") {
        return Ok(false);
    }
    check_name(checkout, branch)?;
    if remote.starts_with('-') {
        return err(format!("No remote {remote}."));
    }
    git(checkout, &["push", "--quiet", "-u", remote, branch], stop)?;
    Ok(true)
}

/// Makes branch `name` from `from` (else what's checked out) and switches the folder to it.
pub fn create(
    checkout: &Checkout,
    name: &str,
    from: Option<&str>,
    stop: &AtomicBool,
) -> io::Result<()> {
    folder_only(checkout)?;
    check_name(checkout, name)?;
    let mut args = vec!["switch", "--quiet", "-c", name];
    if let Some(from) = from {
        if from.starts_with('-') {
            return err(format!("No branch {from}."));
        }
        args.push(from);
    }
    git(checkout, &args, stop)
}
