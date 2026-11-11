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

/// A push the remote turned away because its branch has commits this one doesn't [D1034]: the
/// remote, its ref and the commit it was at when asked, for force push's confirm to pin
/// [D1049]. `moved`: a force push whose lease no longer held, so `oid` is where it is now.
#[derive(Debug)]
pub struct Rejected {
    /// The local branch that was pushed: a force push from another one is refused.
    pub branch: String,
    pub remote: String,
    pub dest: String,
    pub oid: String,
    pub moved: bool,
    said: String,
}

impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(&self.said)
    }
}

impl std::error::Error for Rejected {}

impl Rejected {
    /// `e`'s rejection, if a push was turned away.
    pub fn of(e: &io::Error) -> Option<&Rejected> {
        e.get_ref().and_then(|inner| inner.downcast_ref())
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({"branch": self.branch, "remote": self.remote, "ref": self.dest, "oid": self.oid, "moved": self.moved})
    }
}

/// Pushes `branch` to the same name on `remote` and tracks it there: Publish and Create PR's push.
/// `hooks`: the project is trusted, so its pre-push hook runs.
pub fn push(
    checkout: &Checkout,
    remote: &str,
    branch: &str,
    hooks: bool,
    stop: &AtomicBool,
) -> io::Result<()> {
    let dest = format!("refs/heads/{branch}");
    push_to(
        checkout,
        remote,
        branch,
        &dest,
        &["--set-upstream"],
        hooks,
        stop,
    )
}

/// Pushes `branch` to `dest` on `remote`, one explicit refspec so push mappings never send more,
/// under the checkout's lock, never asking for a password: a plain sentence comes back instead,
/// git's own output after it. A push turned away for the remote's newer commits is a `Rejected`.
pub fn push_to(
    checkout: &Checkout,
    remote: &str,
    branch: &str,
    dest: &str,
    extra: &[&str],
    hooks: bool,
    stop: &AtomicBool,
) -> io::Result<()> {
    let _held = lock(checkout, true, stop)?;
    push_held(checkout, remote, branch, dest, extra, hooks, stop)
}

/// `push_to` for a caller that holds the checkout's lock.
pub(crate) fn push_held(
    checkout: &Checkout,
    remote: &str,
    branch: &str,
    dest: &str,
    extra: &[&str],
    hooks: bool,
    stop: &AtomicBool,
) -> io::Result<()> {
    let refspec = format!("refs/heads/{branch}:{dest}");
    worktrees::names::publishing(checkout, branch)?;
    let mut command = match hooks {
        true => worktrees::with_hooks(&checkout.root),
        false => worktrees::command(&checkout.root),
    };
    // The login shell's PATH, so a hook finds its tools (git-lfs) when the app was opened from Finder.
    command
        .env("PATH", setup::login().path)
        .env("GCM_INTERACTIVE", "never")
        .args(["push", "--quiet"])
        .args(extra)
        .args(["--", remote, &refspec]);
    let out = setup::run_until(&mut command, PUSH_SECS, stop).map_err(io::Error::other)?;
    if out.status.success() {
        return Ok(());
    }
    let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
    // Proposed words. One plain sentence, then git's own output after a blank line for Details.
    let has = |words: &[&str]| words.iter().any(|w| why.contains(w));
    let details = match why.is_empty() {
        true => format!("git push: {}", out.status),
        false => why.clone(),
    };
    let stale = has(&["(stale info)"]);
    if stale || has(&["(fetch first)", "(non-fast-forward)"]) {
        // Where the remote's branch is now, as the confirm's lease pins it.
        if let Some(oid) = remote_oid(checkout, remote, dest, stop) {
            let said = match stale {
                true => "The remote's branch moved since you looked, so nothing was replaced.",
                false => {
                    "The remote's branch has commits this one doesn't, so it refused the push."
                }
            };
            return Err(io::Error::other(Rejected {
                branch: branch.into(),
                remote: remote.into(),
                dest: dest.into(),
                oid,
                moved: stale,
                said: format!("{said}\n\n{details}"),
            }));
        }
    }
    let plain = if has(&["(fetch first)", "(non-fast-forward)", "(stale info)"]) {
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
    Err(io::Error::other(format!("{plain}\n\n{details}")))
}

/// The commit `dest` is at on `remote` now, asked of where pushes go: its pushurl if it has one.
fn remote_oid(checkout: &Checkout, remote: &str, dest: &str, stop: &AtomicBool) -> Option<String> {
    let pushurl = read(
        &checkout.root,
        &["config", "--get", &format!("remote.{remote}.pushurl")],
        stop,
    )
    .ok()
    .map(|out| String::from_utf8_lossy(&out).trim().to_string())
    .filter(|url| !url.is_empty());
    let mut command = worktrees::command(&checkout.root);
    command.env("GCM_INTERACTIVE", "never").args([
        "ls-remote",
        "--",
        pushurl.as_deref().unwrap_or(remote),
        dest,
    ]);
    let out = setup::run_until(&mut command, PUSH_SECS, stop).ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    (text.lines())
        .find(|line| line.ends_with(&format!("\t{dest}")))
        .and_then(|line| line.split('\t').next())
        .map(String::from)
}
