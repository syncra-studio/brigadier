//! `commands <id>` or `commands @home --backend B [--project P]`: the / menu's list, the agent's own
//! commands as it last listed them. Kept per agent and project, so Home's draft and a session the
//! agent hasn't started in yet show it without starting a CLI [D2009, D2022]; never listed, its fixed ones
//! [D2098]. `commands <id> reveal <name>`
//! shows a listed one's file in Finder.

use super::{HOME_DRAFT, arg, flag};
use brigadier_core::{self as core, adapters, check_id, projects};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

fn kept(data: &Path, backend: &str, project: Option<&str>) -> Option<PathBuf> {
    let project = project.filter(|p| check_id(p).is_ok())?;
    check_id(backend).ok()?;
    Some(
        data.join("commands")
            .join(backend)
            .join(format!("{project}.json")),
    )
}

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let owner = arg(args, 1)?;
    let (backend, project, listed, run) = if owner == HOME_DRAFT {
        let backend = flag(args, "--backend").unwrap_or_default().to_string();
        (
            backend,
            flag(args, "--project").map(String::from),
            None,
            None,
        )
    } else {
        let spec = core::load(data, owner)?;
        let f = core::fold(&spec.dir, true)?;
        // The agent the session runs on now, after any switch; the spec's before the first turn.
        let backend = match f.fold.backend.as_str() {
            "" => spec.backend.clone(),
            b => b.to_string(),
        };
        let run = core::as_run(&spec, &f.fold, &backend, None);
        let mut listed = f.fold.commands.get(&backend).cloned();
        if let (Some(list), Some(a)) = (
            listed.as_mut().and_then(Value::as_array_mut),
            adapters::get(&backend),
        ) {
            a.locate(&run, list);
        }
        (backend, spec.project, listed, Some(run))
    };
    let at = kept(data, &backend, project.as_deref());
    let mut commands = match (listed, &at) {
        (Some(list), Some(at)) => {
            // shortcut: written as it's asked for; a list no composer asks for stays stale until one does.
            fs::create_dir_all(at.parent().unwrap())?;
            // By its path in the checkout: the project's other checkouts read the list too.
            let mut inside = list.clone();
            relative(&mut inside, run.as_ref().map_or("", |run| &run.cwd));
            core::write_atomic(at, &serde_json::to_vec(&inside)?)?;
            list
        }
        (Some(list), None) => list,
        (None, at) => (at.as_ref())
            .and_then(|at| fs::read(at).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| {
                // Never listed here: the agent's fixed ones, as the old app's menu before a CLI ran; Home's
                // reads its project's folder only once trusted, as the old app did [D2098].
                let cwd = match &run {
                    Some(run) => Some(PathBuf::from(&run.cwd)),
                    None => (project.as_deref())
                        .and_then(|p| projects::get(data, p).ok())
                        .filter(|p| p.trusted == Some(true))
                        .map(|p| PathBuf::from(p.folder)),
                };
                let fixed =
                    adapters::get(&backend).map(|a| a.fixed_commands(cwd.as_deref(), run.as_ref()));
                json!(fixed.unwrap_or_default())
            }),
    };
    // The user's skills removed or not on for the project, whichever agent lists them.
    let hidden = core::library::hidden(data, project.as_deref());
    if let Some(l) = commands.as_array_mut() {
        l.retain(|each| !hidden.has(each));
    }
    // The library's skills and servers on for the project, at once, before any CLI ran [D409].
    for i in core::library::on_for(data, project.as_deref()) {
        let skill = i["kind"] == "skill";
        let path = skill.then(|| Path::new(i["path"].as_str().unwrap_or("")).join("SKILL.md"));
        if let Some(l) =
            (commands.as_array_mut()).filter(|l| !l.iter().any(|l| l["name"] == i["name"]))
        {
            l.push(json!({"name": i["name"], "description": i["description"],
                "kind": if skill { "skill" } else { "mcp" }, "path": path, "instant": false}));
        }
    }
    if let Some(run) = &run {
        relative(&mut commands, &run.cwd);
    }
    // `reveal <name>`: a listed file outside the checkout shows in Finder, as the old app's file links [D2098].
    if args.get(2).map(String::as_str) == Some("reveal") {
        let name = arg(args, 3)?;
        let path = (commands.as_array().into_iter().flatten())
            .find(|each| each["name"] == name)
            .and_then(|each| each["path"].as_str())
            .filter(|path| path.starts_with('/'))
            .ok_or_else(|| io::Error::other(format!("/{name} has no file to show")))?;
        let shown = std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .status()?;
        return match shown.success() {
            true => Ok(json!({"ok": true})),
            false => Err(io::Error::other(format!("Couldn't reveal {path}"))),
        };
    }
    Ok(json!({"ok": true, "commands": commands}))
}

/// A file in the checkout opens in Files' viewer by its path there; one outside it keeps its whole path [D146].
fn relative(list: &mut Value, cwd: &str) {
    for each in list.as_array_mut().into_iter().flatten() {
        let path = Path::new(each["path"].as_str().unwrap_or(""));
        if let Ok(inside) = path.strip_prefix(cwd) {
            each["path"] = inside.to_string_lossy().into();
        }
    }
}
