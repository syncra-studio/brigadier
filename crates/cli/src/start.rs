//! `start <id> …`: a new session and its first message [D30, D160, D388]. Every way it fails before
//! its host is asked to take the message is marked so (`unsent`), so a new chat Home's book keeps
//! (`--home`) and refused that way is given back [C65].

// Its options as the book reads them: words that look like one (`--cid`) stay `--text`'s [C65].
use crate::attach::book::{has_opt as has, opt as flag};
use crate::attach::{self, book::unsent};
use crate::{accounts, arg, control, models, overnight, owner, plugins, settings, tabs, title};
use brigadier_core::{self as core, Spec, adapters};
use brigadier_frames::log;
use serde_json::{Value, json};
use std::path::Path;
use std::{env, fs, io};

pub(crate) fn start(data: &Path, args: &[String]) -> io::Result<Value> {
    let (spec, parts) = match ready(data, args).map_err(unsent)? {
        Ok(ready) => ready,
        // No account it could start on: refused before any host [C36].
        Err(refused) => return Ok(refused),
    };
    match flag(args, "--text") {
        Some(text) => {
            let cid = flag(args, "--cid").map_or_else(control::new_cid, String::from);
            let reply = control::send(data, &spec, text, parts, Some(&cid), None, None, false)?;
            Ok(core::applied(&spec.dir, &cid, reply))
        }
        None => Ok(json!({"ok": true, "id": spec.id})),
    }
}

/// The session made, or loaded on a retry, with its files and worktree, and its host up; else the
/// reply refusing it for want of a signed-in account.
fn ready(data: &Path, args: &[String]) -> io::Result<Result<(Spec, Value), Value>> {
    let id = arg(args, 1)?;
    if [core::SETUP, core::TERM].iter().any(|p| id.starts_with(p)) {
        let kept = format!("{id:?} is kept for setup runs and terminals");
        return Err(io::Error::other(kept));
    }
    let backend = flag(args, "--backend").unwrap_or("fake");
    if adapters::get(backend).is_none() {
        return Err(io::Error::other(format!("unknown backend {backend}")));
    }
    let opts = args
        .windows(2)
        .filter(|w| w[0] == "--opt")
        .filter_map(|w| w[1].split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    // New project sessions have their own worktree unless Local checkout is chosen [D160].
    let (projects_lock, projects) = core::projects::locked(data)?;
    let project = flag(args, "--project")
        .map(|p| {
            let found = projects.into_iter().find(|r| r.id == p);
            found.ok_or_else(|| io::Error::other(format!("no project {p}")))
        })
        .transpose()?;
    if project.as_ref().is_some_and(|p| p.removing) {
        return Err(io::Error::other("This project is being removed."));
    }
    let worktree = project.is_some() && !has(args, "--local");
    // A chat with no project works in a folder of its own, gone with the session [D35, D388].
    let scratch = has(args, "--scratch").then(|| core::session_dir(data, id).join("scratch"));
    let cwd = flag(args, "--cwd")
        .map(String::from)
        .or_else(|| worktree.then(|| core::worktrees::path(data, id).display().to_string()))
        .or_else(|| project.as_ref().map(|p| p.folder.clone()))
        .or_else(|| scratch.as_ref().map(|d| d.display().to_string()))
        .unwrap_or_else(|| env::current_dir().unwrap_or_default().display().to_string());
    let spec = Spec {
        project: project.as_ref().map(|p| p.id.clone()),
        id: id.into(),
        backend: backend.into(),
        mode: "pipe".into(),
        cwd,
        model: flag(args, "--model").map(String::from),
        // Unpicked, Rust's default for the agent and the project's trust [D187, D239].
        level: flag(args, "--level").map(String::from).or_else(|| {
            let held = models::held(data, project.as_ref().map(|p| p.id.as_str()));
            let chosen = settings::get(data, "default_level");
            adapters::get(backend)
                .and_then(|a| models::default_level(a, held, &chosen).map(String::from))
        }),
        effort: flag(args, "--effort").map(String::from),
        fast: has(args, "--fast"),
        opts,
        created: log::now_ms(),
        ..Default::default()
    };
    if let Some(a) = adapters::get(backend) {
        core::level(&spec, a, false).map_err(io::Error::other)?;
    }
    let fresh = !core::session_dir(data, id).join("session.json").exists();
    let mut told = None;
    let spec = if fresh {
        let (spec, c) = accounts::picked(data, spec);
        // Its Use pick unusable: on the login while Providers shows it, else not at all [C36].
        if let Err(why) = accounts::fell_back(data, &spec, c.as_ref(), "chat").map(|why| told = why)
        {
            return Ok(Err(
                json!({"ok": false, "error": "sign_in", "message": why}),
            ));
        }
        plugins::sync(data);
        core::share::one_local(data, project.as_ref(), &spec)?;
        core::create(data, &spec)?
    } else {
        core::load(data, id)?
    };
    // Before its first message, which tells its agent.
    if fresh && has(args, "--overnight") {
        overnight::on(data, &spec, None)?;
    }
    let parts = flag(args, "--parts").map_or(Ok(Value::Null), serde_json::from_str)?;
    core::message::take(data, &spec.dir, &parts, flag(args, "--from"))?;
    // The tabs are extras: a failure here never stops the session from starting.
    if fresh && has(args, "--carry-tabs") {
        let _ = tabs::carry(data, id);
    }
    if let Some(dir) = &scratch {
        fs::create_dir_all(dir)?;
    }
    let own = Path::new(&spec.cwd) == core::worktrees::path(data, id);
    if let Some(project) = project.filter(|_| worktree && own) {
        let base = flag(args, "--base");
        let title = flag(args, "--text").map_or_else(
            || title::from(&fs::read_to_string(spec.dir.join("title")).unwrap_or_default()),
            title::from,
        );
        let made = core::folder::ensure(&spec, &project, base, &title);
        // A fresh session it undid goes too, what it took back with its draft; on a retry it
        // keeps its log and first message [D35]. Home's book undoes its own, its chat's draft
        // taken first [C80].
        let undone = fresh && !has(args, "--home");
        if made.is_err() && undone && !spec.dir.join(core::worktrees::RECORD).exists() {
            attach::back(data, &spec, &parts, has(args, "--carry-tabs"))?;
            fs::remove_dir_all(&spec.dir)?;
        }
        made?;
    }
    drop(projects_lock);
    owner::ensure(data, &spec)?;
    accounts::tell(data, id, told);
    Ok(Ok((spec, parts)))
}
