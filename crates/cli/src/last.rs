//! `brigadier source <id> review last` and `review-file last <before> <after> <path> [<from>]`:
//! Review's Last turn [D1000, D1035, D1192], or a night's turns with `night:<since>-<at>` for `last`;
//! and the brief every review carries, risky files and the session's last test or build run
//! [D1188, D1213].

use super::arg;
use brigadier_core::git::{self, Target, branch, last, risk};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;

/// A night's scope, from when it began to when it ended (ms).
pub(super) fn night(scope: &str) -> Option<(u64, u64)> {
    let (since, at) = scope.strip_prefix("night:")?.split_once('-')?;
    Some((since.parse().ok()?, at.parse().ok()?))
}

/// Last turn's two moves, a night's the same; None for every other.
pub(super) fn route(data: &Path, args: &[String]) -> io::Result<Option<Value>> {
    let (target, at) = super::git::target(args)?;
    let word = |i: usize| args.get(at + i).map(String::as_str);
    let scope = word(1).unwrap_or_default();
    let span = night(scope);
    if (scope != "last" && span.is_none()) || !matches!(word(0), Some("review" | "review-file")) {
        return Ok(None);
    }
    let none = |why: &str| {
        let none = json!({"scope": scope, "base": null, "files": [], "insertions": 0,
                          "deletions": 0, "none": why});
        Ok(Some(json!({"ok": true, "review": none})))
    };
    // A claimed repo's turns aren't captured: Branch and Uncommitted show its work [D494].
    if let Target::Repo(..) = target {
        return none("noSnapshot");
    }
    let Target::Session(id) = target else {
        return none("noProject");
    };
    let spec = brigadier_core::load(data, id)?;
    if spec.project.is_none() {
        return none("noProject");
    }
    let Ok(checkout) = git::checkout(data, &target) else {
        return none("notGit");
    };
    if word(0) == Some("review-file") {
        let trees = (arg(args, at + 2)?, arg(args, at + 3)?);
        let from = word(5).filter(|w| *w != "-");
        let contents = last::file(&spec, &checkout, trees, arg(args, at + 4)?, from)?;
        return Ok(Some(json!({"ok": true, "contents": contents})));
    }
    let f = brigadier_core::fold(&spec.dir, true)?.fold;
    let moments = match span {
        Some(span) => last::night(&spec, &f, &checkout, scope, span),
        None => last::of(&spec, &f, &checkout),
    };
    let mut review = match moments {
        Ok(turn) => turn.list()?,
        // The folder now couldn't be captured at once: the app keeps what it drew and asks again.
        Err("busy") => return Ok(Some(json!({"ok": false, "busy": true, "error": "busy"}))),
        Err(why) => return none(why),
    };
    // Another session in this folder: its work may be in the turn's diff [D1078].
    review["shared"] = (branch::sharing(data, &checkout).iter())
        .any(|other| other != id)
        .into();
    brief(&spec, &f, &checkout, &mut review);
    Ok(Some(json!({"ok": true, "review": review})))
}

fn brief(
    spec: &brigadier_core::Spec,
    f: &brigadier_core::fold::Fold,
    checkout: &git::Checkout,
    review: &mut Value,
) {
    let cwd = fs::canonicalize(&spec.cwd).unwrap_or_else(|_| spec.cwd.clone().into());
    risk::brief(review, f.runs.last.as_ref(), &checkout.root, &cwd);
    // Your own folder: the listed files the agent's edit steps confirm it changed, the open turn's
    // too; the rest are "Other changes", never called the user's [D1192, D1213].
    if !checkout.worktree {
        let open = f.turns.first().map(|t| &t.edited);
        let agent: Vec<String> = (f.runs.agent.iter().chain(open.into_iter().flatten()))
            .filter_map(|p| {
                Some(
                    cwd.join(p)
                        .strip_prefix(&checkout.root)
                        .ok()?
                        .to_string_lossy()
                        .into_owned(),
                )
            })
            .filter(|p| {
                (review["files"].as_array().into_iter().flatten()).any(|f| f["path"] == p.as_str())
            })
            .collect();
        review["agent"] = agent.into();
    }
}

/// Every other scope's review gets the brief too: a session's with its last run, a project's
/// with its flags alone.
pub(super) fn briefed(data: &Path, args: &[String], mut reply: Value) -> Value {
    if !reply["review"].is_object() {
        return reply;
    }
    let Ok((target, at)) = super::git::target(args) else {
        return reply;
    };
    if args.get(at).map(String::as_str) != Some("review") {
        return reply;
    }
    let Ok(checkout) = git::checkout(data, &target) else {
        return reply;
    };
    let session = match target {
        Target::Session(id) => brigadier_core::load(data, id).ok(),
        Target::Project(_) | Target::Repo(..) => None,
    };
    let f = session
        .as_ref()
        .and_then(|s| brigadier_core::fold(&s.dir, true).ok());
    match (session, f) {
        (Some(spec), Some(f)) => brief(&spec, &f.fold, &checkout, &mut reply["review"]),
        _ => risk::brief(&mut reply["review"], None, &checkout.root, &checkout.root),
    }
    reply
}
