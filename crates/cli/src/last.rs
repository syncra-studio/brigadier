//! `brigadier source <id> review last` and `review-file last <before> <after> <path> [<from>]`:
//! Review's Last turn [D1000, D1035, D1192]; and the brief every review carries, risky files and
//! the session's last test or build run [D1188, D1213].

use super::arg;
use brigadier_core::git::{self, Target, branch, last, risk};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;

/// Last turn's two moves; None for every other.
pub(super) fn route(data: &Path, args: &[String]) -> io::Result<Option<Value>> {
    let (target, at) = super::git::target(args)?;
    let word = |i: usize| args.get(at + i).map(String::as_str);
    if word(1) != Some("last") || !matches!(word(0), Some("review" | "review-file")) {
        return Ok(None);
    }
    let none = |why: &str| {
        let none = json!({"scope": "last", "base": null, "files": [], "insertions": 0,
                          "deletions": 0, "none": why});
        Ok(Some(json!({"ok": true, "review": none})))
    };
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
    let mut review = match last::of(&spec, &f, &checkout) {
        Ok(turn) => turn.list()?,
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
        Target::Project(_) => None,
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
