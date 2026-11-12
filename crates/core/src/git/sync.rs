//! Auto-fetch of every published branch [D1026], and when each remote was last fetched. Git does the work.

use super::{Checkout, Target, checkout, read};
use crate::adapters::setup;
use crate::{ids, projects, session_dir, worktrees};
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
