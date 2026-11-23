//! The user's terminals, only in tabs [D315, repo D360]: each tab's shell runs on its own host
//! (`term-<tab id>`, see `core::TERM`), so it outlives the app and its screen comes back whole
//! from its log [repo D60]. Whose a terminal is is the tabs file that holds its tab, so a draft's
//! tab carried into its new session takes its shell along unchanged [repo D282, repo D284].
//!
//! `terminal <owner> start <tab> [cols] [rows]` starts the tab's shell once, `restart` starts an
//! ended one again; both answer whether it runs. `terminal sweep` stops and removes every terminal
//! no open tab of a live owner holds: run after a terminal tab closes, a session is archived or
//! deleted, a project is removed, and at the daemon's start, so a cleanup cut short is finished
//! [repo D35]. `<owner>` is a session, `@home` or `@home:<project>`, as `tabs` takes.

pub(crate) mod agent;
pub(crate) mod notes;
mod shell;

use super::{TERMINAL, Tab, Tabs, file, lock, read};
use crate::{HOME_DRAFT, arg, owner};
use brigadier_core::{self as core, Spec, TERM, adapters, projects, session};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    if args[0] == "shell" {
        return shell::run(data, args);
    }
    if arg(args, 1)? == "sweep" {
        sweep(data);
        return Ok(json!({"ok": true}));
    }
    let (owner, op, tab) = (arg(args, 1)?, arg(args, 2)?, arg(args, 3)?);
    if owner != HOME_DRAFT {
        core::check_id(owner.strip_prefix("@home:").unwrap_or(owner))?;
    }
    let size = |i: usize| args.get(i).and_then(|v| v.parse().ok());
    // `--run <line>`: typed into the new shell and run, as the user would (Open in terminal).
    let typed = crate::flag(args, "--run").map(|line| format!("{line}\r"));
    match op {
        "start" | "restart" => start(
            data,
            owner,
            tab,
            op == "restart",
            (size(4), size(5)),
            typed.as_deref(),
        ),
        _ => Err(io::Error::other(format!("unknown terminal command {op}"))),
    }
}

fn start(
    data: &Path,
    owner: &str,
    tab: &str,
    again: bool,
    (cols, rows): (Option<u16>, Option<u16>),
    typed: Option<&str>,
) -> io::Result<Value> {
    core::check_id(tab)?;
    let id = format!("{TERM}{tab}");
    // Its owner's lock, then the sweep's: a tab closing, or its session archiving, can't miss it.
    let _owner = lock(data, owner)?;
    let _sweep = lock_sweep(data)?;
    if !terminals(data, owner).iter().any(|t| t == tab) {
        return Err(io::Error::other("No such terminal tab"));
    }
    let cwd = cwd(data, owner)?;
    let exists = core::session_dir(data, &id).join("session.json").exists();
    if exists && (!again || live(data, &id)) {
        return Ok(json!({"ok": true, "id": id, "live": live(data, &id)}));
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let spec = Spec {
        id: id.clone(),
        backend: "terminal".into(),
        mode: "pty".into(),
        cwd: cwd.display().to_string(),
        created: brigadier_frames::log::now_ms(),
        ..Default::default()
    };
    let mut env = adapters::base_env(&spec, Path::new(&shell), &[]);
    env.extend(
        [("SHELL", shell.as_str()), ("COLORTERM", "truecolor")].map(|(k, v)| (k.into(), v.into())),
    );
    env.push((
        "LOGNAME".into(),
        std::env::var("LOGNAME").unwrap_or_default(),
    ));
    // What it printed before (a restart's earlier shell), when a line is to be typed.
    let dir = core::session_dir(data, &id);
    let printed = typed.map_or(0, |_| tail(&dir, 1 << 20).len());
    let reply = crate::setup::in_terminal(data, &spec, vec![shell, "-l".into()], env, cols, rows)?;
    if reply["ok"] != true {
        let why = reply["error"].as_str().unwrap_or("The shell didn't start");
        return Err(io::Error::other(why.to_string()));
    }
    if let Some(line) = typed {
        // Typed once its prompt shows (3 s at most), so the line isn't echoed above it.
        for _ in 0..30 {
            if tail(&dir, 1 << 20).len() > printed {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let keys = json!({"op": "keys", "spawn": reply["spawn"], "bytes": line});
        owner::call(data, &id, keys)?;
    }
    Ok(json!({"ok": true, "id": id, "live": true}))
}

/// Where an owner's terminals open: its session's folder; Home's draft's project, or the home folder
/// for a chat in none [D320].
fn cwd(data: &Path, owner: &str) -> io::Result<PathBuf> {
    if let Some(project) = owner.strip_prefix("@home:") {
        return Ok(projects::get(data, project)?.folder.into());
    }
    if owner == HOME_DRAFT {
        return Ok(adapters::home_path(""));
    }
    let spec = core::load(data, owner)?;
    if let Some(why) = session::closed(&spec.dir) {
        return Err(io::Error::other(why));
    }
    Ok(spec.cwd.into())
}

/// Whether its shell runs now.
fn live(data: &Path, id: &str) -> bool {
    owner::state(data, id) != core::fold::Owner::Dead
        && owner::call(data, id, json!({"op": "ping"})).is_ok_and(|p| !p["child"].is_null())
}

/// Every terminal an open tab of a live owner holds: a session not archived or going, Home's
/// draft, a project's draft while the project is there.
fn held(data: &Path) -> HashSet<String> {
    let (mut owners, mut held) = (vec![HOME_DRAFT.to_string()], HashSet::new());
    for entry in fs::read_dir(data).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(project) = name
            .strip_prefix("home-tabs-")
            .and_then(|n| n.strip_suffix(".json"))
            && projects::get(data, project).is_ok()
        {
            owners.push(format!("@home:{project}"));
        }
    }
    for id in core::ids(data) {
        let dir = core::session_dir(data, &id);
        if dir.join("session.json").exists() && session::retired(&dir).is_none() {
            owners.push(id);
            // Its `!` commands too, ended ones' output kept for reading [D316].
            let commands = fs::read_dir(dir.join("commands"))
                .into_iter()
                .flatten()
                .flatten();
            held.extend(commands.map(|c| c.file_name().to_string_lossy().to_string()));
        }
    }
    held.extend(owners.iter().flat_map(|o| terminals(data, o)));
    held
}

/// What each of `owner`'s terminals printed lately, while its shell runs: for Local servers [repo D508].
pub(crate) fn printed(data: &Path, owner: &str) -> Vec<String> {
    // Its `!` commands too: a dev server run with `!` [D316].
    let mut ids = terminals(data, owner);
    ids.extend(agent::commands(data, owner));
    let ids = ids.into_iter().map(|t| format!("{TERM}{t}"));
    ids.filter(|id| live(data, id))
        .map(|id| String::from_utf8_lossy(&tail(&core::session_dir(data, &id), 256 << 10)).into())
        .collect()
}

/// The last `most` bytes a terminal's programs wrote, from its log.
// shortcut: reads the whole log each time; keep an offset once logs grow large.
pub(crate) fn tail(dir: &Path, most: usize) -> Vec<u8> {
    let mut out = std::collections::VecDeque::new();
    let Ok(mut r) = brigadier_frames::log::Reader::open(&dir.join("log"), 0, 0) else {
        return vec![];
    };
    use brigadier_frames::log::{ERR, OUT, PTY};
    while let Ok(Some(f)) = r.next_with(|k| matches!(k, PTY | OUT | ERR)) {
        out.extend(f.data);
        let over = out.len().saturating_sub(most);
        out.drain(..over);
    }
    out.into()
}

/// The terminal tabs open in an owner's tabs, by id.
fn terminals(data: &Path, owner: &str) -> Vec<String> {
    let tabs = read(&file(data, owner)).tabs.into_iter();
    tabs.filter(|t| t.kind == TERMINAL).map(|t| t.id).collect()
}

/// A terminal tab closed in this change: its shell goes with it, its history too [D320].
pub(super) fn closed(data: &Path, was: &Tabs, now: &Tabs) {
    let gone = |t: &Tab| t.kind == TERMINAL && !now.tabs.iter().any(|n| n.id == t.id);
    if was.tabs.iter().any(gone) {
        sweep(data);
    }
}

/// Stops and removes each terminal nothing holds: its host first, then its folder [repo D35].
pub fn sweep(data: &Path) {
    let Ok(_sweep) = lock_sweep(data) else {
        return;
    };
    let held = held(data);
    for entry in fs::read_dir(data.join("terminals"))
        .into_iter()
        .flatten()
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().to_string();
        if held.contains(&name) || core::check_id(&name).is_err() {
            continue;
        }
        let id = format!("{TERM}{name}");
        let _ = owner::call(data, &id, json!({"op": "stop", "by": "user"}));
        // A host that won't exit keeps its folder, for the next sweep.
        if owner::release(data, &id).is_ok() {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Stops every terminal and `!` command `owner` holds, before its folder is checkpointed or
/// removed; the sweep after removes them [repo D35].
pub(crate) fn stop_all(data: &Path, owner: &str) {
    let Ok(_sweep) = lock_sweep(data) else {
        return;
    };
    let mut ids = terminals(data, owner);
    ids.extend(agent::commands(data, owner));
    for id in ids.iter().map(|t| format!("{TERM}{t}")) {
        let _ = owner::call(data, &id, json!({"op": "stop", "by": "user"}));
        let _ = owner::release(data, &id);
    }
}

/// Held by every start and every sweep, so a sweep never takes a terminal or command being started.
fn lock_sweep(data: &Path) -> io::Result<fs::File> {
    projects::lock(data, "terminals.lock")
}
