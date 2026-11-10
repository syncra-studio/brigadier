//! Pushing one branch to its remote [D1030, D1060]: the remote git itself would pick, one explicit
//! refspec so push mappings never send more than that branch, under the checkout's lock.

use super::{Checkout, lock, read};
use crate::adapters::setup;
use crate::worktrees;
use std::io;
use std::sync::atomic::AtomicBool;

/// Proposed: a push gives up after this.
const PUSH_SECS: u64 = 120;

/// The remote `branch` pushes to, in git's own order: its pushRemote, remote.pushDefault, its
/// remote, then origin, then the only remote there is.
pub fn remote(checkout: &Checkout, branch: &str) -> io::Result<String> {
    let never = AtomicBool::new(false);
    let config = |key: &str| {
        read(&checkout.root, &["config", "--get", key], &never)
            .ok()
            .map(|out| String::from_utf8_lossy(&out).trim().to_string())
            .filter(|value| !value.is_empty() && value != ".")
    };
    if let Some(remote) = config(&format!("branch.{branch}.pushRemote"))
        .or_else(|| config("remote.pushDefault"))
        .or_else(|| config(&format!("branch.{branch}.remote")))
    {
        return Ok(remote);
    }
    let out = read(&checkout.root, &["remote"], &never)?;
    let remotes: Vec<String> = String::from_utf8_lossy(&out)
        .lines()
        .map(String::from)
        .collect();
    match &remotes[..] {
        [only] => Ok(only.clone()),
        _ if remotes.iter().any(|r| r == "origin") => Ok("origin".into()),
        [] => Err(io::Error::other(
            "This repository has no remote to push to.",
        )),
        _ => Err(io::Error::other(
            "This repository has several remotes and none is set for pushing.",
        )),
    }
}

/// Where `remote` pushes, as it was given before git's `insteadOf` rewrites: its pushurl, else
/// its url. That names the host and the repository the branch lands in.
pub fn url(checkout: &Checkout, remote: &str) -> io::Result<String> {
    let never = AtomicBool::new(false);
    let get = |key: String| read(&checkout.root, &["config", "--get", &key], &never);
    let out =
        get(format!("remote.{remote}.pushurl")).or_else(|_| get(format!("remote.{remote}.url")))?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// Pushes `branch` to the same name on `remote` and tracks it there, never asking for a password:
/// a plain sentence comes back instead, git's own output after it. `hooks`: the project is trusted, so its pre-push hook runs.
pub fn push(
    checkout: &Checkout,
    remote: &str,
    branch: &str,
    hooks: bool,
    stop: &AtomicBool,
) -> io::Result<()> {
    let _held = lock(checkout, true, stop)?;
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    let mut command = match hooks {
        true => worktrees::with_hooks(&checkout.root),
        false => worktrees::command(&checkout.root),
    };
    // The login shell's PATH, so a hook finds its tools (git-lfs) when the app was opened from Finder.
    command
        .env("PATH", setup::login().path)
        .env("GCM_INTERACTIVE", "never")
        .args(["push", "--quiet", "--set-upstream", "--", remote, &refspec]);
    let out = setup::run_until(&mut command, PUSH_SECS, stop).map_err(io::Error::other)?;
    if out.status.success() {
        return Ok(());
    }
    let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
    // Proposed words. One plain sentence, then git's own output after a blank line for Details.
    let has = |words: &[&str]| words.iter().any(|w| why.contains(w));
    let plain = if has(&["(fetch first)", "(non-fast-forward)"]) {
        "The remote's branch has commits this one doesn't, so it refused the push."
    } else if has(&[
        "Authentication failed",
        "Permission denied",
        "could not read Username",
        "terminal prompts disabled",
        "returned error: 403",
    ]) {
        "The remote didn't accept your sign-in for this push."
    } else if has(&[
        "Could not resolve host",
        "Could not read from remote",
        "unable to access",
        "timed out",
    ]) {
        "Couldn't reach the remote."
    } else if has(&["[remote rejected]", "hook declined"]) {
        "The remote refused the push."
    } else {
        "The push didn't go through."
    };
    let details = match why.is_empty() {
        true => format!("git push: {}", out.status),
        false => why,
    };
    Err(io::Error::other(format!("{plain}\n\n{details}")))
}
