//! Checkout facts, including a missing session worktree [D1187]. No branch moves on a read.

use super::{Checkout, Target, checkout, folder, read, sync};
use crate::{load, share, worktrees};
use serde_json::{Value, json};
use std::io;
use std::path::Path;
use std::sync::atomic::AtomicBool;

/// Facts survive a missing worktree; a missing folder of the user's is an ordinary read error.
pub fn state(data: &Path, target: &Target, stop: &AtomicBool) -> io::Result<Value> {
    let holder = match target {
        Target::Session(id) => {
            crate::check_id(id)?;
            share::holder(data, &load(data, id)?)
        }
        Target::Project(_) => None,
    };
    let lands = holder
        .as_ref()
        .map(|s| worktrees::lands(&s.dir))
        .transpose()?
        .flatten();
    let path = folder(data, target)?;
    let missing = match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound && lands.is_some() => true,
        Err(e) => return Err(e),
        Ok(_) => false,
    };
    let mut truth = json!({"missing": missing, "restorable": false, "branch": null,
        "head": null, "detached": null, "recordedBranch": lands.as_ref().and_then(|l| l.branch.as_ref()),
        "mismatch": false, "base": null});
    if missing {
        truth["restorable"] = (holder
            .as_ref()
            .is_some_and(|s| crate::session::closed(&s.dir).is_none())
            && lands.as_ref().is_some_and(|l| l.branch.is_some()))
        .into();
        return Ok(truth);
    }
    let checkout = checkout(data, target)?;
    let now = super::status(&checkout, stop)?;
    truth["branch"] = now.head["branch"].clone();
    truth["head"] = now.head["head"].clone();
    if now.head["branch"].is_null() && !now.head["head"].is_null() {
        truth["detached"] = String::from_utf8(read(
            &checkout.root,
            &["rev-parse", "--short", "HEAD"],
            stop,
        )?)
        .map_err(io::Error::other)?
        .trim()
        .into();
    }
    truth["mismatch"] = (truth["branch"].is_string()
        && truth["recordedBranch"].is_string()
        && truth["branch"] != truth["recordedBranch"])
        .into();
    if let Some(lands) = lands {
        truth["base"] = base(&checkout, &lands.base, stop)?;
    }
    Ok(truth)
}

/// The base's own upstream, behind count and its remote's last successful fetch [D1193].
pub fn base(checkout: &Checkout, name: &str, stop: &AtomicBool) -> io::Result<Value> {
    let out = read(
        &checkout.root,
        &[
            "for-each-ref",
            "--format=%(refname)%00%(upstream:short)%00%(upstream:remotename)",
            &format!("refs/heads/{name}"),
            &format!("refs/remotes/{name}"),
        ],
        stop,
    )?;
    let text = String::from_utf8_lossy(&out);
    let mut upstream = None;
    let mut remote = None;
    let mut behind = None;
    for line in text.lines() {
        let parts: Vec<_> = line.split('\0').collect();
        let [full, up, from] = parts.as_slice() else {
            continue;
        };
        if *full == format!("refs/heads/{name}") && !up.is_empty() {
            upstream = Some((*up).to_string());
            remote = Some((*from).to_string()).filter(|r| r != ".");
            let count = read(
                &checkout.root,
                &["rev-list", "--count", &format!("{name}..{up}")],
                stop,
            )?;
            behind = String::from_utf8_lossy(&count).trim().parse::<u64>().ok();
        } else if *full == format!("refs/remotes/{name}") {
            upstream = Some(name.to_string());
            let remotes = read(&checkout.root, &["remote"], stop)?;
            remote = String::from_utf8_lossy(&remotes)
                .lines()
                .filter(|r| name.starts_with(&format!("{r}/")))
                .max_by_key(|r| r.len())
                .map(String::from);
        }
    }
    let at = remote.and_then(|r| sync::fetched_at(checkout, &r));
    Ok(json!({"name": name, "upstream": upstream, "behind": behind, "fetchedAtMs": at}))
}

/// A PR read may have just recorded a merge; use it in this same step read [D1187].
pub(super) fn landing(data: &Path, id: &str, now: &super::Status) -> Option<Value> {
    if !now.files.is_empty() {
        return None;
    }
    let holder = share::holder(data, &load(data, id).ok()?)?;
    let lands = worktrees::lands(&holder.dir).ok()??;
    let landed = lands.landing?;
    let head = now.head["head"].as_str()?;
    (now.head["branch"].as_str() == lands.branch.as_deref()
        && worktrees::landed(&lands.repo, &lands.base, head, &landed))
    .then(|| json!({"kind": "landed", "base": lands.base, "atMs": landed.at_ms}))
}
