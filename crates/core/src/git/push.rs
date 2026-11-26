//! The remote a branch pushes to and its URL, as git itself would pick them [D1030, D1060].

use super::{Checkout, read};
use std::io;
use std::sync::atomic::AtomicBool;

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
    let remotes = remotes(checkout)?;
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

/// The checkout's remotes, as `git remote` lists them.
pub fn remotes(checkout: &Checkout) -> io::Result<Vec<String>> {
    let out = read(&checkout.root, &["remote"], &AtomicBool::new(false))?;
    Ok(String::from_utf8_lossy(&out)
        .lines()
        .map(String::from)
        .collect())
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
