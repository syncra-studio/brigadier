//! `brigadier source <owner> make-commit` and `write`: Source's commit and the message writer
//! [D1029, D1107]. The writer is the session's own agent at its cheapest model, and a local model
//! only when the computer is offline; it never commits a message nobody wrote.

use brigadier_core::adapters::{self, ModelInfo};
use brigadier_core::fold::Fold;
use brigadier_core::git::commit::{self, Prepared};
use brigadier_core::git::{Checkout, Target};
use brigadier_core::{self as core, Spec, projects, writer};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::AtomicBool;

/// What the user sees when nothing was written [D1029].
const UNWRITTEN: &str = "Couldn't write a message. Type one.";

/// Each model an agent's last check listed, in any folder, the first folder's list that has any.
fn models(data: &Path, name: &str) -> Vec<ModelInfo> {
    let path = data.join("agents").join(format!("{name}.json"));
    let all: Value = (fs::read(path).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let lists = all.as_object().into_iter().flat_map(|m| m.values());
    let found = lists
        .filter_map(|c| c["models"].as_array())
        .find(|l| !l.is_empty());
    (found.into_iter().flatten())
        .map(|m| ModelInfo {
            id: m["id"].as_str().unwrap_or("").into(),
            local: m["local"] == true,
            efforts: (m["efforts"].as_array().into_iter().flatten())
                .filter_map(|e| e.as_str().map(String::from))
                .collect(),
            ..ModelInfo::default()
        })
        .filter(|m| !m.id.is_empty())
        .collect()
}

/// The session whose agent writes for `target`, and whose folder keeps its records: the session
/// itself; for a project folder, the project's newest session that still has its folder
/// (proposed) [D1039, D1045].
pub(super) fn author(data: &Path, target: &Target) -> Option<(Spec, Fold)> {
    let spec = match target {
        Target::Session(id) => core::load(data, id).ok()?,
        Target::Project(project) => (core::ids(data).iter())
            .filter_map(|id| core::load(data, id).ok())
            .filter(|s| s.project.as_deref() == Some(*project) && Path::new(&s.cwd).is_dir())
            .max_by_key(|s| s.created)?,
    };
    let f = core::fold(&spec.dir, true).ok()?.fold;
    Some((spec, f))
}

/// One write of `prompt` (built from the session's own asks) on the author's agent at its
/// cheapest model; offline, on a local model any agent listed [D1029]. The reason why not, else.
pub(super) fn written(
    data: &Path,
    target: &Target,
    prompt: impl Fn(&[String]) -> String,
) -> Result<String, String> {
    let (spec, f) = author(data, target).ok_or("no session here has an agent to write with")?;
    let prompt = prompt(&writer::asks(&spec.dir));
    let backend = match f.backend.as_str() {
        "" => spec.backend.clone(),
        b => b.to_string(),
    };
    let a = adapters::get(&backend).ok_or_else(|| format!("no agent {backend}"))?;
    let account = f.accounts.get(&backend).cloned().unwrap_or_default();
    let mut run = core::as_run(&spec, &f, &backend, None);
    let listed = models(data, &backend);
    if let Some(model) = a.cheap(run.model.as_deref(), &listed) {
        run.effort =
            (listed.iter().find(|m| m.id == model)).and_then(|m| m.efforts.first().cloned());
        run.model = Some(model);
    }
    let ready = |run: &mut Spec, a: &dyn adapters::Adapter| {
        run.cid = Some(adapters::uuid());
        run.dir = writer::home(&spec.dir);
        run.level = a.can().levels.first().map(|l| l.to_string());
        run.grants = vec![];
    };
    ready(&mut run, a);
    let failure = match writer::write(a, &run, &account, &prompt) {
        Ok(text) => return Ok(text),
        Err(failure) => failure,
    };
    if !failure.offline {
        return Err(failure.why);
    }
    for local in adapters::all() {
        let Some(model) = models(data, local.name()).into_iter().find(|m| m.local) else {
            continue;
        };
        let mut run = core::as_run(&spec, &f, local.name(), None);
        (run.account, run.model, run.effort) = (None, Some(model.id), None);
        ready(&mut run, local);
        return writer::write(local, &run, "", &prompt).map_err(|e| e.why);
    }
    Err(failure.why)
}

/// The project's own git hooks run only once it's trusted [D166].
fn trusted(data: &Path, target: &Target) -> bool {
    let project = match target {
        Target::Session(id) => core::load(data, id).ok().and_then(|s| s.project),
        Target::Project(id) => Some(id.to_string()),
    };
    project.is_some_and(|p| projects::get(data, &p).is_ok_and(|p| p.trusted == Some(true)))
}

fn unwritten(why: String) -> Value {
    eprintln!("message writer: {why}");
    json!({"ok": false, "error": UNWRITTEN, "writer": true})
}

pub(super) fn commit_prompt(
    checkout: &Checkout,
    prepared: &Prepared,
    stop: &AtomicBool,
) -> impl Fn(&[String]) -> String {
    let subjects = commit::subjects(checkout, 10, stop);
    let patch = prepared.patch.clone();
    move |asks| writer::commit_prompt(&patch, &subjects, asks)
}

/// `make-commit [--all] [--message M]`: commits the index, or with `--all` every change, with M; a
/// blank M is written first, for exactly what will be committed [D1029, D1107].
pub(super) fn make(
    data: &Path,
    target: &Target,
    checkout: &Checkout,
    all: bool,
    message: Option<&str>,
) -> io::Result<Value> {
    let stop = AtomicBool::new(false);
    let prepared = commit::prepare(checkout, all, &stop)?;
    let message = match message.map(str::trim).filter(|m| !m.is_empty()) {
        Some(typed) => typed.to_string(),
        None => match super::message_draft::cached(data, target, checkout, &prepared, all)
            .map(Ok)
            .unwrap_or_else(|| written(data, target, commit_prompt(checkout, &prepared, &stop)))
        {
            Ok(text) => text,
            Err(why) => return Ok(unwritten(why)),
        },
    };
    // Our own commit in a folder others share waits for no other session's turn; the message is
    // written first, so no turn waits on the writer [D1082].
    let me = match target {
        Target::Session(id) => Some(*id),
        Target::Project(_) => None,
    };
    let folder = brigadier_core::git::folder(data, target)?;
    let _shared = super::sessions::guard(data, &folder, me)?;
    let sha = commit::commit(
        checkout,
        &prepared,
        all,
        &message,
        trusted(data, target),
        &stop,
    )?;
    Ok(json!({"ok": true, "sha": sha, "message": message}))
}

/// `write commit [--all] | pr | squash`: a message for the field, a PR's title and body, or a
/// squash's message, written and returned, nothing committed [D1029].
pub(super) fn write(
    data: &Path,
    target: &Target,
    checkout: &Checkout,
    what: &str,
    all: bool,
) -> io::Result<Value> {
    let stop = AtomicBool::new(false);
    let text = match what {
        "commit" => {
            let prepared = commit::prepare(checkout, all, &stop)?;
            written(data, target, commit_prompt(checkout, &prepared, &stop))
        }
        "pr" | "squash" => {
            let Target::Session(id) = target else {
                return Err(io::Error::other("A project folder has no base."));
            };
            let base = core::share::base(data, &core::load(data, id)?)
                .ok_or_else(|| io::Error::other("This session has no base."))?;
            let (commits, patch) = commit::branch(checkout, &base, &stop)?;
            match what {
                "pr" => written(data, target, |asks| {
                    writer::pr_prompt(&patch, &commits, asks)
                }),
                _ => written(data, target, |asks| {
                    writer::commit_prompt(&patch, &commits, asks)
                }),
            }
        }
        _ => return Err(io::Error::other(super::USAGE)),
    };
    Ok(match text {
        Ok(text) => json!({"ok": true, "text": text}),
        Err(why) => unwritten(why),
    })
}
