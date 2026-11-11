//! `source <owner> first <merge|squash|push|link|pr|sync|publish> <head> <base|-> [--message M]
//! [--title T --body B --draft]`: the one button's move, which commits every change first, then
//! lands, pushes or syncs, in one click [D1203, D1207]. `pull-only` and `push-only`: your own
//! folder's Pull only and Push only [D1205].
//!
//! Pinned to the HEAD and base its step was worked out on, checked before the commit is prepared
//! and again under the commit's lock [D1049]. Refused while an agent works in the folder: the
//! session's own turn start waits on its lock, and the folder's other sessions on the shared guard,
//! from just before the commit until the move is done [D1208, D1082, D1165]. A move refused after
//! the commit takes the commit back, so a refusal never leaves one behind.

use super::{arg, flag, has};
use brigadier_core::git::{self, Checkout, Target, commit, land, step, sync};
use brigadier_core::{host, session_dir, share, worktrees};
use serde_json::{Value, json};
use std::fs::File;
use std::io;
use std::path::Path;
use std::sync::atomic::AtomicBool;

const MOVED: &str = "Something changed since it was checked. Look again.";

fn refuse<T>(why: impl Into<String>) -> io::Result<T> {
    Err(io::Error::other(why.into()))
}

/// Held from just before a change until the move is done: no turn starts in the folder, and none
/// works there now, the session's own included [D1208, D1082].
fn hold(data: &Path, target: &Target) -> io::Result<(Option<File>, Option<File>)> {
    let me = match target {
        Target::Session(id) => Some(*id),
        Target::Project(_) => None,
    };
    let mine = me
        .map(|id| worktrees::lock(&session_dir(data, id)))
        .transpose()?;
    if let Some(id) = me
        && super::sessions::working(data, id, &brigadier_frames::procs::all())
    {
        return refuse("Waits for the turn to finish.");
    }
    let shared = super::sessions::guard(data, &git::folder(data, target)?, me)?;
    Ok((mine, shared))
}

pub(super) fn run(
    data: &Path,
    target: &Target,
    checkout: &Checkout,
    args: &[String],
    at: usize,
) -> io::Result<Value> {
    let stop = AtomicBool::new(false);
    let word = |i: usize| arg(args, at + i);
    let hooks = sync::trusted(data, target);
    let only = match word(0)? {
        "pull-only" => Some((true, false)),
        "push-only" => Some((false, true)),
        _ => None,
    };
    if let Some(only) = only {
        if checkout.worktree {
            return refuse("This session lands through its button.");
        }
        let _held = hold(data, target)?;
        sync::sync_only(checkout, hooks, only, &stop)?;
        return Ok(json!({"ok": true}));
    }
    let (verb, head) = (word(1)?, word(2)?);
    let base = Some(word(3)?).filter(|b| *b != "-");
    let id = match target {
        Target::Session(id) => Some(*id),
        Target::Project(_) => None,
    };
    let session = || id.map_or_else(|| refuse(super::USAGE), Ok);
    if commit::head_now(checkout, &stop).as_deref() != Some(head) {
        return refuse(MOVED);
    }
    // Everything the move would refuse for is asked before anything is committed.
    let pr = match verb {
        "merge" | "squash" => {
            let read = step::step(data, target, false, &stop)?;
            let (now, pinned) = (&read["step"], &read["at"]);
            if now["kind"] != "merge" || pinned["head"] != head || pinned["base"].as_str() != base {
                return refuse(MOVED);
            }
            if !now["blocked"].is_null() {
                return refuse("It can't merge now. Look again.");
            }
            if verb == "squash" && flag(args, "--message").is_none_or(|m| m.trim().is_empty()) {
                return refuse("A squash needs a message.");
            }
            None
        }
        "push" | "link" | "pr" => {
            let id = session()?;
            if verb != "push"
                && let Some(owner) = share::lands(data, id)
            {
                return refuse(format!("Landing stays with {owner} while it's there."));
            }
            if verb == "pr" && flag(args, "--title").is_none_or(|t| t.trim().is_empty()) {
                return refuse("Give the PR a title.");
            }
            Some(host::pr(data, id)?)
        }
        "sync" | "publish" => None,
        _ => return refuse(super::USAGE),
    };
    let prepared = commit::prepare(checkout, true, &stop)?;
    if prepared.head.as_deref() != Some(head) {
        return refuse(MOVED);
    }
    // A message typed in Edit message… or a squash's own stands; else the writer writes it, or
    // nothing is committed [D1029, D1212].
    let message = match flag(args, "--message")
        .map(str::trim)
        .filter(|m| !m.is_empty())
    {
        Some(typed) => typed.to_string(),
        None => match super::commit::written_for(data, target, checkout, &prepared) {
            Ok(text) => text,
            Err(reply) => return Ok(reply),
        },
    };
    let _held = hold(data, target)?;
    // `commit` checks the HEAD again under its lock [D1049].
    let made = commit::commit(checkout, &prepared, true, &message, hooks, &stop)?;
    let (title, body) = (
        flag(args, "--title").unwrap_or(""),
        flag(args, "--body").unwrap_or(""),
    );
    let pinned = (made.as_str(), base.unwrap_or(""));
    let moved = match (verb, &pr) {
        ("merge", _) => land::land(data, session()?, "merge", None, pinned, &stop)
            .map(|landed| json!({"ok": true, "landed": landed})),
        ("squash", _) => land::land(data, session()?, "squash", Some(&message), pinned, &stop)
            .map(|landed| json!({"ok": true, "landed": landed})),
        ("push", Some(pr)) => pr.push().map(|_| json!({"ok": true})),
        ("link", Some(pr)) => pr
            .link(title, body)
            .map(|url| json!({"ok": true, "url": url})),
        ("pr", Some(pr)) => (pr.create(title, body, has(args, "--draft")))
            .map(|made| json!({"ok": true, "pr": made})),
        ("publish", _) => sync::publish(checkout, hooks, &stop).map(|_| json!({"ok": true})),
        _ => sync::sync(checkout, hooks, &stop).map(|_| json!({"ok": true})),
    };
    moved.inspect_err(|_| {
        commit::take_back(checkout, &made, head, &stop);
    })
}
