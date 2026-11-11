//! The right panel's memory [D1014, D1033]: open or closed and its width for the whole app, in
//! `panel.json`, and the view each session last showed in its own folder, gone with it [D35]
//! (Home's beside the app's). Every change is safe to send twice and answers the state with a
//! `rev` that only grows, so the app tells Rust's newer word from an older one [D30, D71].
//!
//! `shown <id>`: that session is on screen. The first time one is whose turn changed files, the
//! panel opens on its Source, once per install, and the answer says how many files [D1023, D1125].

use crate::{HOME_DRAFT, USAGE, arg};
use brigadier_core::{self as core, projects, worktrees};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

const VIEWS: [&str; 2] = ["files", "source"];
/// The view a session shows before it's picked one, as the old app [D48].
const FIRST: &str = "files";

#[derive(Default, Serialize, Deserialize)]
struct Panel {
    rev: u64,
    open: bool,
    width: Option<u32>,
    /// Home's view.
    home: Option<String>,
    /// It has opened by itself once [D1023].
    opened_once: bool,
}

fn lock(data: &Path) -> io::Result<File> {
    projects::lock(data, "panel.lock")
}

fn read(data: &Path) -> Panel {
    (fs::read(data.join("panel.json")).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write(data: &Path, panel: &mut Panel) -> io::Result<()> {
    panel.rev += 1;
    core::write_atomic(&data.join("panel.json"), &serde_json::to_vec(panel)?)
}

fn view_file(data: &Path, id: &str) -> PathBuf {
    core::session_dir(data, id).join("panel.json")
}

fn view_of(data: &Path, panel: &Panel, id: &str) -> String {
    let saved = match id {
        HOME_DRAFT => panel.home.clone(),
        _ => (fs::read(view_file(data, id)).ok())
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|v| v["view"].as_str().map(String::from)),
    };
    saved
        .filter(|v| VIEWS.contains(&v.as_str()))
        .unwrap_or_else(|| FIRST.into())
}

/// Keeps `id`'s view: a session's under its lifecycle lock, so none lands on one being deleted.
fn set_view(data: &Path, panel: &mut Panel, id: &str, view: &str) -> io::Result<()> {
    if !VIEWS.contains(&view) {
        return Err(io::Error::other(USAGE));
    }
    if id == HOME_DRAFT {
        panel.home = Some(view.into());
        return Ok(());
    }
    let _lock = worktrees::lock(&core::session_dir(data, id))?;
    core::write_atomic(
        &view_file(data, id),
        json!({"view": view}).to_string().as_bytes(),
    )
}

fn state(data: &Path, panel: &Panel, id: Option<&str>) -> Value {
    let mut state = json!({"ok": true, "rev": panel.rev, "open": panel.open, "width": panel.width});
    if let Some(id) = id {
        state["view"] = view_of(data, panel, id).into();
    }
    state
}

/// `panel [<id>] | open on|off | width <px> | view <id> <view> | shown <id>`.
pub(super) fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = |i: usize| -> io::Result<&str> {
        let id = arg(args, i)?;
        if id != HOME_DRAFT {
            core::check_id(id)?;
        }
        Ok(id)
    };
    let _lock = lock(data)?;
    let mut panel = read(data);
    match args.get(1).map(String::as_str) {
        None => Ok(state(data, &panel, None)),
        Some("open") => {
            panel.open = match arg(args, 2)? {
                "on" => true,
                "off" => false,
                _ => return Err(io::Error::other(USAGE)),
            };
            write(data, &mut panel)?;
            Ok(state(data, &panel, None))
        }
        Some("width") => {
            let width: u32 = (arg(args, 2)?.parse().ok())
                .filter(|w| (1..10_000).contains(w))
                .ok_or_else(|| io::Error::other(USAGE))?;
            panel.width = Some(width);
            write(data, &mut panel)?;
            Ok(state(data, &panel, None))
        }
        // Showing a view opens the panel on it.
        Some("view") => {
            let owner = id(2)?;
            set_view(data, &mut panel, owner, arg(args, 3)?)?;
            panel.open = true;
            write(data, &mut panel)?;
            Ok(state(data, &panel, Some(owner)))
        }
        Some("shown") => {
            let owner = id(2)?;
            let mut opened = Value::Null;
            if !panel.opened_once && owner != HOME_DRAFT {
                let spec = core::load(data, owner)?;
                let edited = core::fold(&spec.dir, true)?.fold.edited;
                if let Some(edited) = edited {
                    panel.opened_once = true;
                    // Already open, it has nothing to teach.
                    if !panel.open {
                        set_view(data, &mut panel, owner, "source")?;
                        panel.open = true;
                        opened = edited["files"].clone();
                    }
                    write(data, &mut panel)?;
                }
            }
            let mut state = state(data, &panel, Some(owner));
            state["opened"] = opened;
            Ok(state)
        }
        Some(_) => Ok(state(data, &panel, Some(id(1)?))),
    }
}
