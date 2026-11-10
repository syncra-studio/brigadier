//! Send as new [D183, D204, D205, D206]: a message from a project session starts a new session in
//! the same project, carried as the old app did, with no thread context. The source's log holds the
//! operation: its intent (target id, command id, text) before anything is made, then its result
//! under the same target id, so the source's line and Put back's text survive a crash [D204, D71].
//! Run again under the same ids, it goes on from what the logs prove: a target whose message is
//! in its log is never sent again or removed [D54].

use crate::{arg, flag, models, owner, queue, title};
use brigadier_core::{self as core};
use serde_json::{Value, json};
use std::fs::OpenOptions;
use std::io;
use std::path::Path;

/// `side <source> <new-id> --text T --cid C [--qid Q]`. `--qid`: the queued message the text was
/// edited from, settled once the intent is logged [D237].
pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let (source, target) = (arg(args, 1)?, arg(args, 2)?);
    core::check_id(target)?;
    let need = |name: &str| flag(args, name).ok_or_else(|| io::Error::other(crate::USAGE));
    let src = core::load(data, source)?;
    let Some(project) = src.project.clone() else {
        return Err(io::Error::other(
            "Only a session in a project can start another.",
        ));
    };
    if target == source {
        return Err(io::Error::other("A session can't start itself."));
    }
    // One run of an operation at a time, per source.
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(src.dir.join("side.lock"))?;
    lock.lock()?;
    let (intent, done) = records(&src.dir, target)?;
    if let Some(done) = done {
        return Ok(reply(target, &done));
    }
    owner::ensure(data, &src)?;
    let note = |data_: Value| owner::call(data, source, json!({"op": "note", "data": data_}));
    // A replay keeps the logged command id and text: the log holds the operation.
    let (cid, text) = match intent {
        Some(i) => (str_of(&i, "cid"), str_of(&i, "text")),
        None => {
            let (cid, text) = (need("--cid")?.to_string(), need("--text")?.to_string());
            core::check_id(&cid)?;
            note(
                json!({"event": "side", "phase": "intent", "session": target, "cid": cid, "text": text}),
            )?;
            (cid, text)
        }
    };
    if let Some(qid) = flag(args, "--qid") {
        // The edit is over once the message went elsewhere; one already gone is fine.
        let remove = ["queue", source, "remove", qid].map(String::from);
        let _ = queue::run(data, &remove);
    }

    let dir = core::session_dir(data, target);
    let accepted = || core::fold(&dir, true).is_ok_and(|f| f.fold.cids.contains_key(&cid));
    let failed = if accepted() {
        None
    } else {
        match crate::run(
            data,
            &start_args(data, &src, &project, target, &text, &cid)?,
        ) {
            Ok(r) if r["result"] == "delivered" || r["result"] == "logged" => None,
            Ok(r) => Some(
                r["message"]
                    .as_str()
                    .or(r["error"].as_str())
                    .unwrap_or("Refused")
                    .to_string(),
            ),
            Err(e) => Some(e.to_string()),
        }
    };
    // PROPOSED: a message that reached the target's log counts as started; its own row shows the rest.
    let result = match failed.filter(|_| !accepted()) {
        None => json!({"event": "side", "phase": "done", "session": target, "ok": true,
            "base": core::worktrees::base(&dir), "title": title::from(&text)}),
        Some(error) => {
            // A failed start takes its session away; what delete couldn't remove is said [D35].
            let mut left = vec![];
            if dir.join("session.json").exists() {
                match crate::run(data, &["delete".to_string(), target.to_string()]) {
                    Ok(gone) => {
                        left.extend(strings(&gone["left"]));
                        left.extend(strings(&gone["kept_branches"]).map(|b| format!("branch {b}")));
                    }
                    Err(e) => left.push(format!("{}: {e}", dir.display())),
                }
            }
            json!({"event": "side", "phase": "done", "session": target, "ok": false,
                "error": error, "left": left})
        }
    };
    note(result.clone())?;
    Ok(reply(target, &result))
}

/// The start a send as new runs: the source's project, a new worktree from the branch the source
/// started from, the model and effort its next turn would use [D129, D225], and its level unless
/// that's Full access, which falls to the project default [D187, D205].
fn start_args(
    data: &Path,
    src: &core::Spec,
    project: &str,
    target: &str,
    text: &str,
    cid: &str,
) -> io::Result<Vec<String>> {
    let f = core::fold(&src.dir, true)?.fold;
    let backend = models::next_agent(src, &f).to_string();
    let (model, effort) = match &f.picked {
        Some(p) => (Some(p.model.clone()), p.effort.clone()),
        None => {
            let run = core::as_run(src, &f, &backend, None);
            (run.model, run.effort)
        }
    };
    let mut args: Vec<String> = ["start", target, "--backend", &backend, "--project", project]
        .map(String::from)
        .into();
    let mut push = |name: &str, value: Option<String>| {
        if let Some(v) = value {
            args.extend([name.to_string(), v]);
        }
    };
    push("--model", model);
    push("--effort", effort);
    // Held, Rust's default is Ask whatever the source ran at [D166].
    let held = models::held(data, Some(project));
    push(
        "--level",
        src.level.clone().filter(|l| l != "full" && !held),
    );
    push("--base", core::share::base(data, src));
    push("--text", Some(text.into()));
    push("--cid", Some(cid.into()));
    Ok(args)
}

/// The operation's intent and result notes in the source's log, by target id.
fn records(dir: &Path, target: &str) -> io::Result<(Option<Value>, Option<Value>)> {
    let (mut intent, mut done) = (None, None);
    core::read(dir, |item| {
        if item["kind"] == "note" && item["event"] == "side" && item["session"] == target {
            match item["phase"].as_str() {
                Some("intent") => intent = Some(item.clone()),
                _ => done = Some(item.clone()),
            }
        }
    })?;
    Ok((intent, done))
}

fn reply(target: &str, done: &Value) -> Value {
    json!({"ok": done["ok"] == true, "session": target, "error": done["error"], "left": done["left"]})
}

fn str_of(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").to_string()
}

fn strings(v: &Value) -> impl Iterator<Item = String> + '_ {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str().map(String::from))
}
