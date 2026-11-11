//! `brigadier source <owner> make-commit` and `write`: the card's commit and the message writer
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

/// Whether an agent's last check lists `model`, as the picker offers it: an agent on an
/// environment key or a local server lists models with no saved sign-in.
fn offered(data: &Path, name: &str, model: &str) -> bool {
    let path = data.join("agents").join(format!("{name}.json"));
    let all: Value = (fs::read(path).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    (all.as_object().into_iter().flat_map(|m| m.values()))
        .any(|c| (c["models"].as_array().into_iter().flatten()).any(|m| m["id"] == model))
}

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
fn author(data: &Path, target: &Target) -> Option<(Spec, Fold)> {
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
fn written(
    data: &Path,
    target: &Target,
    prompt: impl Fn(&[String]) -> String,
) -> Result<String, String> {
    let (spec, f) = author(data, target).ok_or("no session here has an agent to write with")?;
    let _active = writer::hold(&spec.dir).map_err(|e| e.to_string())?;
    let chosen = writer::choice(data).map_err(|e| e.to_string())?;
    // A saved model its agent no longer offers stays saved, and Automatic writes meanwhile, as in the old app [D1224].
    let chosen = chosen.filter(|c| offered(data, &c.backend, &c.model));
    written_for(data, &spec, &f, &_active, chosen.as_ref(), prompt)
}

fn written_for(
    data: &Path,
    spec: &Spec,
    f: &Fold,
    active: &fs::File,
    chosen: Option<&writer::Choice>,
    prompt: impl Fn(&[String]) -> String,
) -> Result<String, String> {
    let prompt = prompt(&writer::asks(&spec.dir));
    let backend = match chosen {
        Some(choice) => choice.backend.clone(),
        None => match f.backend.as_str() {
            "" => spec.backend.clone(),
            b => b.to_string(),
        },
    };
    let a = adapters::get(&backend).ok_or_else(|| format!("no agent {backend}"))?;
    let account = f.accounts.get(&backend).cloned().unwrap_or_default();
    let mut run = core::as_run(spec, f, &backend, None);
    let listed = models(data, &backend);
    if let Some(model) = chosen
        .map(|c| c.model.clone())
        .or_else(|| a.cheap(run.model.as_deref(), &listed))
    {
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
    let failure = match writer::write(a, &run, &account, &prompt, active) {
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
        let mut run = core::as_run(spec, f, local.name(), None);
        (run.account, run.model, run.effort) = (None, Some(model.id), None);
        ready(&mut run, local);
        return writer::write(local, &run, "", &prompt, active).map_err(|e| e.why);
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

/// Nothing written: why, in the agent's own words where it gave them [D1324], its last line that
/// isn't a raw event; the whole of what it said, as details.
fn unwritten(why: String) -> Value {
    eprintln!("message writer: {why}");
    let said = (why.lines().map(str::trim)).rfind(|l| !l.is_empty() && !l.starts_with(['{', '[']));
    let details = (Some(why.trim()) != said).then_some(why.trim());
    json!({"ok": false, "error": said, "details": details, "writer": true})
}

fn commit_prompt(
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
        None => match written(data, target, commit_prompt(checkout, &prepared, &stop)) {
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
    // No turn starts in the session while it commits, and none may be working now, whichever way
    // the commit was asked for; its lock before the checkout's, as a turn start does [D1082, D1235].
    let _one = me
        .map(|id| brigadier_core::worktrees::lock(&brigadier_core::session_dir(data, id)))
        .transpose()?;
    if let Some(id) = me
        && super::sessions::working(data, id, &brigadier_frames::procs::all())
    {
        return Err(io::Error::other("Waits for the turn to finish."));
    }
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

/// `write pr`: a PR's title and body, written and returned, nothing committed [D1029].
pub(super) fn write(
    data: &Path,
    target: &Target,
    checkout: &Checkout,
    what: &str,
) -> io::Result<Value> {
    let stop = AtomicBool::new(false);
    let text = match what {
        "pr" => {
            let Target::Session(id) = target else {
                return Err(io::Error::other("A project folder has no base."));
            };
            let base = core::share::base(data, &core::load(data, id)?)
                .ok_or_else(|| io::Error::other("This session has no base."))?;
            let (commits, patch) = commit::branch(checkout, &base, &stop)?;
            written(data, target, |asks| {
                writer::pr_prompt(&patch, &commits, asks)
            })
        }
        _ => return Err(io::Error::other(super::USAGE)),
    };
    Ok(match text {
        Ok(text) => json!({"ok": true, "text": text}),
        Err(why) => unwritten(why),
    })
}
