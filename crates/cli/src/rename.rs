//! A title rename follows onto a branch only while publication and active turns allow [D1217].

use super::{arg, flag, has, index, sessions, title};
use brigadier_core::git::{self, Target, branch, sync};
use brigadier_core::{self as core, projects, worktrees};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

pub(super) fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    let spec = core::load(data, id)?;
    let name = title::clean(arg(args, 2)?).map_err(io::Error::other)?;
    // Hosted reads take no session, checkout or turn locks. Their identity is checked again below.
    let checkout = git::checkout(data, &Target::Session(id)).ok();
    let all = brigadier_frames::procs::all();
    let busy = checkout.as_ref().is_some_and(|c| {
        branch::sharing(data, c)
            .iter()
            .any(|id| sessions::working(data, id, &all))
    });
    let observed = match &checkout {
        Some(c) if c.worktree && !busy && worktrees::names::has_remotes(&c.root)? => {
            core::host::pr(data, id).ok()
        }
        _ => None,
    };
    let prs = observed.as_ref().and_then(|p| p.list());
    let _session = worktrees::lock(&spec.dir)?;
    let spec = core::load(data, id)?;
    // Never wait for a lock held by an operation that may need this session's lock.
    let _fence = worktrees::names::turn_fence(data)?;
    let current = worktrees::lands(&spec.dir)?;
    let checkout = git::checkout(data, &Target::Session(id)).ok();
    let mut next = None;
    let mut reason = "This session has no branch of its own.";
    let mut checkout_lock = None;
    if _fence.is_none() {
        reason = "A source action is running, so the branch keeps its name.";
    } else if let (Some(lands), Some(checkout)) = (&current, &checkout)
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
            let file = std::fs::File::open(&checkout.git_dir)?;
            match file.try_lock() {
                Err(std::fs::TryLockError::WouldBlock) => {
                    reason = "A source action is running, so the branch keeps its name."
                }
                Err(std::fs::TryLockError::Error(e)) => return Err(e),
                Ok(()) => {
                    checkout_lock = Some(file);
                    if sync::branch(checkout)? != old {
                        reason = "The checkout is on another branch, so its name stays.";
                    } else if !worktrees::names::unpublished(&spec.dir)? {
                        reason = "The branch was published or a push was attempted, so its name stays.";
                    } else {
                        let same = match &observed {
                            Some(was) => core::host::pr(data, id).is_ok_and(|now| {
                                now.branch == was.branch
                                    && now.remote == was.remote
                                    && now.repo == was.repo
                            }),
                            None => !worktrees::names::has_remotes(&checkout.root)?,
                        };
                        let no_pr = if observed.is_none() {
                            same
                        } else {
                            same && prs
                                .as_ref()
                                .and_then(Value::as_array)
                                .is_some_and(Vec::is_empty)
                        };
                        if no_pr {
                            let prefix = spec
                                .project
                                .as_deref()
                                .map(|p| projects::get(data, p))
                                .transpose()?
                                .and_then(|p| p.branch_prefix);
                            next = Some(worktrees::names::choose(
                                &lands.repo,
                                prefix.as_deref(),
                                &name,
                                Some(old),
                            )?);
                            reason = "";
                        } else {
                            reason = match prs.as_ref().and_then(Value::as_array) {
                                Some(prs) if !prs.is_empty() => {
                                    "The branch has a pull request, so its name stays."
                                }
                                _ => "Couldn't check pull requests, so the branch keeps its name.",
                            };
                        }
                    }
                }
            }
        }
    }
    if has(args, "--preview") {
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
        worktrees::rename_held(&spec.dir, next)?;
    }
    core::write_atomic(&spec.dir.join("title"), name.as_bytes())?;
    drop(checkout_lock);
    Ok(json!({"ok": true, "at": index::touched(&spec.dir), "branch": next, "reason": reason}))
}
