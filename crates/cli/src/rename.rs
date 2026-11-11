//! A title rename follows onto a branch only while publication and active turns allow [D1217].

use super::{arg, flag, has, index, sessions, title};
use brigadier_core::git::{self, Target, branch, sync};
use brigadier_core::{self as core, projects, worktrees};
use serde_json::{Value, json};
use std::io;
use std::path::Path;
use std::sync::atomic::AtomicBool;

pub(super) fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    let spec = core::load(data, id)?;
    let name = title::clean(arg(args, 2)?).map_err(io::Error::other)?;
    let preview = has(args, "--preview");
    let _fence = branch::fence(data)?;
    let stop = AtomicBool::new(false);
    let current = worktrees::lands(&spec.dir)?;
    let mut next = None;
    let mut reason = "This session has no branch of its own.";
    // Archived worktrees aren't moved by renaming their chat.
    let checkout = git::checkout(data, &Target::Session(id)).ok();
    let mut locks = None;
    if let (Some(lands), Some(checkout)) = (&current, &checkout)
        && let Some(old) = lands.branch.as_deref()
        && checkout.worktree
    {
        let all = brigadier_frames::procs::all();
        if branch::sharing(data, checkout)
            .iter()
            .any(|id| sessions::working(data, id, &all))
        {
            reason = "The branch keeps its name while an agent works in this folder.";
        } else {
            let prefix = spec
                .project
                .as_deref()
                .map(|p| projects::get(data, p))
                .transpose()?
                .and_then(|p| p.branch_prefix);
            let (repo_lock, candidate) =
                worktrees::names::reserve(&lands.repo, prefix.as_deref(), &name, Some(old))?;
            let checkout_lock = git::lock(checkout, true, &stop)?;
            locks = Some((repo_lock, checkout_lock));
            if sync::branch(checkout)? != old {
                reason = "The checkout is on another branch, so its name stays.";
            } else if !worktrees::names::unpublished(&spec.dir)? {
                reason = "The branch has been published, so its name stays.";
            } else {
                // No remotes means no hosted PR. Otherwise a failed/unsupported read proves nothing.
                let prs = match !worktrees::names::has_remotes(&checkout.root)? {
                    true => Some(json!([])),
                    false => core::host::pr(data, id).ok().and_then(|p| p.list()),
                };
                match prs.as_ref().and_then(Value::as_array) {
                    Some(prs) if prs.is_empty() => {
                        next = Some(candidate);
                        reason = "";
                    }
                    Some(_) => reason = "The branch has a pull request, so its name stays.",
                    None => reason = "Couldn't check pull requests, so the branch keeps its name.",
                }
            }
        }
    }
    if preview {
        return Ok(json!({"ok": true, "branch": next, "reason": reason}));
    }
    if let Some(expected) = flag(args, "--branch")
        && expected != next.as_deref().unwrap_or("-")
    {
        return Err(io::Error::other(
            "The branch preview changed. Reopen Rename session and try again.",
        ));
    }
    if let (Some(next), Some(current)) = (&next, &current)
        && current.branch.as_deref() != Some(next)
    {
        worktrees::rename(&spec.dir, next)?;
    }
    core::write_atomic(&spec.dir.join("title"), name.as_bytes())?;
    drop(locks);
    Ok(json!({"ok": true, "at": index::touched(&spec.dir), "branch": next, "reason": reason}))
}
