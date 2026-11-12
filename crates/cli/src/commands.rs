//! `commands <id>` or `commands @home --backend B [--project P]`: the / menu's list, the agent's own
//! commands as it last listed them. Kept per agent and project, so Home's draft and a session the
//! agent hasn't started in yet show it without starting a CLI [D2009, D2022]. `commands <id> reveal <name>`
//! shows a listed one's file in Finder.

use super::{HOME_DRAFT, arg, flag};
use brigadier_core::{self as core, check_id};
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
    let (backend, project, listed) = if owner == HOME_DRAFT {
        let backend = flag(args, "--backend").unwrap_or_default().to_string();
        (backend, flag(args, "--project").map(String::from), None)
    } else {
        let spec = core::load(data, owner)?;
        let f = core::fold(&spec.dir, true)?;
        // The agent the session runs on now, after any switch; the spec's before the first turn.
        let backend = match f.fold.backend.as_str() {
            "" => spec.backend.clone(),
            b => b.to_string(),
        };
        let mut listed = f.fold.commands.get(&backend).cloned();
        // `reveal <name>`: a listed file outside the checkout shows in Finder, as the old app's file links [D2098].
        if args.get(2).map(String::as_str) == Some("reveal") {
            let name = arg(args, 3)?;
            let path = (listed.iter().flat_map(|l| l.as_array()).flatten())
                .find(|each| each["name"] == name)
                .and_then(|each| each["path"].as_str())
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
        // A file in the checkout opens in Files' viewer by its path there; one outside it keeps its whole path [D146].
        for each in (listed.iter_mut()).flat_map(|l| l.as_array_mut()).flatten() {
            let path = Path::new(each["path"].as_str().unwrap_or(""));
            if let Ok(inside) = path.strip_prefix(&spec.cwd) {
                each["path"] = inside.to_string_lossy().into();
            }
        }
        (backend, spec.project, listed)
    };
    let at = kept(data, &backend, project.as_deref());
    let commands = match (listed, &at) {
        (Some(list), Some(at)) => {
            // shortcut: written as it's asked for; a list no composer asks for stays stale until one does.
            fs::create_dir_all(at.parent().unwrap())?;
            core::write_atomic(at, &serde_json::to_vec(&list)?)?;
            list
        }
        (Some(list), None) => list,
        (None, at) => at
            .as_ref()
            .and_then(|at| fs::read(at).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| json!([])),
    };
    Ok(json!({"ok": true, "commands": commands}))
}
