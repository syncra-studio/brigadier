//! Notes moved from their session to their project [D913 D916 D922]: each session's `notes/` and
//! Home's `home-notes/` go to the project's notes folder, or the shared one for chats in none. The
//! whole plan (old place, new place, the id there) is written to `notes-moves.json` before anything
//! moves, so a move cut short is finished by the next run and nothing is lost. A note whose side
//! chat is working stays where it is, still read there, and moves once its chat has stopped.

use super::{all_chats, chats_of, folder, images, resave};
use crate::{owner, sessions};
use brigadier_core::{self as core, check_id, fold::Owner, projects};
use brigadier_frames::procs;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone)]
struct Move {
    /// The note's id where it was, and in its new folder: another only if that one was taken.
    id: String,
    new: String,
    from: PathBuf,
    to: PathBuf,
    /// The project it goes to, whose folder its side chats read; None: a chat in none.
    project: Option<String>,
    done: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Plan {
    moves: Vec<Move>,
}

fn plan_file(data: &Path) -> PathBuf {
    data.join("notes-moves.json")
}

/// Moves what can move now: planned on the first run, then each run moves what still waits.
pub(crate) fn settle(data: &Path) -> io::Result<()> {
    let path = plan_file(data);
    let mut plan: Plan = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => Plan::default(),
        Err(e) => return Err(e),
    };
    if plan.moves.iter().all(|m| m.done) && path.exists() {
        return Ok(());
    }
    let _lock = projects::lock(data, "notes-moves.lock")?;
    // Planned once, and kept before the first file moves.
    if !path.exists() {
        plan = planned(data)?;
        core::write_atomic(&path, &serde_json::to_vec_pretty(&plan)?)?;
    }
    let all = procs::all();
    for i in 0..plan.moves.len() {
        if plan.moves[i].done {
            continue;
        }
        let m = plan.moves[i].clone();
        let chats = chats_of(&m.from, &m.id);
        if chats.iter().any(|c| sessions::working(data, c, &all)) {
            continue;
        }
        // An idle chat's host still holds the old folder: it exits, and its next turn starts here.
        for chat in &chats {
            if owner::state(data, chat) != Owner::Dead {
                owner::release(data, chat)?;
            }
        }
        carry(data, &m)?;
        plan.moves[i].done = true;
        core::write_atomic(&path, &serde_json::to_vec_pretty(&plan)?)?;
    }
    Ok(())
}

/// A note not moved yet, by its id: where it still is.
pub(crate) fn waiting(data: &Path, note: &str) -> Option<PathBuf> {
    let plan: Plan = serde_json::from_slice(&fs::read(plan_file(data)).ok()?).ok()?;
    let m = plan.moves.into_iter().find(|m| !m.done && m.id == note)?;
    Some(m.from.join(format!("{note}.md")))
}

/// The notes still waiting to move into `to`.
pub(crate) fn waiting_into(data: &Path, to: &Path) -> Vec<PathBuf> {
    let Some(plan) = fs::read(plan_file(data))
        .ok()
        .and_then(|b| serde_json::from_slice::<Plan>(&b).ok())
    else {
        return vec![];
    };
    (plan.moves.into_iter())
        .filter(|m| !m.done && m.to == to)
        .map(|m| m.from.join(format!("{}.md", m.id)))
        .filter(|p| p.exists())
        .collect()
}

/// Every note and side chat record in a session's or Home's notes folder, with where it goes.
/// Home's go to the project whose Home has its tab open, else the shared folder.
fn planned(data: &Path) -> io::Result<Plan> {
    let list = projects::list(data)?;
    let known = |p: Option<String>| p.filter(|p| list.iter().any(|x| &x.id == p));
    let mut roots = projects::Roots::default();
    // Each folder with its session's project; Home's (None) by the Home that has the note's tab open.
    let mut places: Vec<(PathBuf, Option<Option<String>>)> = vec![];
    for id in core::ids(data) {
        if let Ok(spec) = core::load(data, &id) {
            let project = known(projects::of(&spec, &list, &mut roots));
            places.push((spec.dir.join("notes"), Some(project)));
        }
    }
    places.push((data.join("home-notes"), None));
    let homes = home_tabs(data);
    let home_of = |note: &str| {
        (homes.iter())
            .find(|(_, tabs)| tabs.contains(note))
            .and_then(|(p, _)| known(p.clone()))
    };
    let mut taken: BTreeSet<PathBuf> = BTreeSet::new();
    let mut moves = vec![];
    for (from, fixed) in places {
        let mut stems = BTreeSet::new();
        for entry in fs::read_dir(&from).into_iter().flatten().flatten() {
            let path = entry.path();
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if matches!(ext, "md" | "chat") && check_id(stem).is_ok() {
                stems.insert(stem.to_string());
            }
        }
        for id in stems {
            let project = fixed.clone().unwrap_or_else(|| home_of(&id));
            let to = folder(data, project.as_deref());
            // Ids are random, so this is a different note only by a rare chance: it gets another id.
            let free =
                |n: &str| !to.join(format!("{n}.md")).exists() && !taken.contains(&to.join(n));
            let new = if free(&id) {
                id.clone()
            } else {
                format!("{id}-{}", &core::adapters::uuid()[..8])
            };
            taken.insert(to.join(&new));
            moves.push(Move {
                id,
                new,
                from: from.clone(),
                to,
                project,
                done: false,
            });
        }
    }
    Ok(Plan { moves })
}

/// Each Home's open note tabs, by the project its Home is (None: Chats').
fn home_tabs(data: &Path) -> Vec<(Option<String>, BTreeSet<String>)> {
    let mut all = vec![];
    for entry in fs::read_dir(data).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(key) = name
            .strip_prefix("home-tabs")
            .and_then(|n| n.strip_suffix(".json"))
        else {
            continue;
        };
        let project = key
            .strip_prefix('-')
            .map(|p| p.trim_end_matches("--page").to_string());
        let tabs: Value = (fs::read(entry.path()).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let notes = (tabs["tabs"].as_array().into_iter().flatten())
            .filter(|t| t["kind"] == "note")
            .filter_map(|t| t["target"].as_str().map(String::from))
            .collect();
        all.push((project, notes));
    }
    all
}

/// One note's move, each part safe to do again: its file, its chats' record, its chats, its tabs.
fn carry(data: &Path, m: &Move) -> io::Result<()> {
    fs::create_dir_all(&m.to)?;
    let md = m.to.join(format!("{}.md", m.new));
    let chats = chats_of(&m.from, &m.id);
    for ext in ["md", "chat", "images"] {
        let from = m.from.join(format!("{}.{ext}", m.id));
        if from.exists() {
            fs::rename(&from, m.to.join(format!("{}.{ext}", m.new)))?;
        }
    }
    if m.new != m.id && md.exists() {
        let text = images::renamed(&fs::read_to_string(&md)?, &m.id, &m.new);
        core::write_atomic(&md, text.as_bytes())?;
    }
    let reads = (m.project.as_deref())
        .and_then(|p| projects::get(data, p).ok())
        .map(|p| p.folder);
    for chat in chats.iter().chain(&chats_of(&m.to, &m.new)) {
        let Ok(mut spec) = core::load(data, chat) else {
            continue;
        };
        spec.cwd = m.to.display().to_string();
        spec.opts.insert("note".into(), md.display().to_string());
        match &reads {
            Some(r) => spec.opts.insert("reads".into(), r.clone()),
            None => spec.opts.remove("reads"),
        };
        resave(&spec)?;
    }
    if m.new != m.id {
        retarget(data, &m.from, &m.id, &m.new)?;
    }
    Ok(())
}

/// Saved note tabs that named `old` name `new`: only those of the owner it came from, its session's
/// or each Home's, as another's tab of that id was another note.
fn retarget(data: &Path, from: &Path, old: &str, new: &str) -> io::Result<()> {
    let owners: Vec<PathBuf> = match from == data.join("home-notes") {
        true => (fs::read_dir(data).into_iter().flatten().flatten())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("home-tabs"))
            })
            .collect(),
        false => from
            .parent()
            .map(|s| s.join("tabs.json"))
            .into_iter()
            .collect(),
    };
    for path in owners
        .into_iter()
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
    {
        let Some(mut tabs) = fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        else {
            continue;
        };
        let mut changed = false;
        let mut fix = |t: &mut Value| {
            if t["kind"] == "note" && t["target"] == old {
                t["target"] = new.into();
                changed = true;
            }
        };
        for c in tabs["closed"].as_array_mut().into_iter().flatten() {
            fix(&mut c["tab"]);
        }
        for t in tabs["tabs"].as_array_mut().into_iter().flatten() {
            fix(t);
        }
        if changed {
            // A new revision, so an app that read these tabs takes the new targets [ARCHITECTURE].
            tabs["rev"] = (tabs["rev"].as_u64().unwrap_or(0) + 1).into();
            core::write_atomic(&path, &serde_json::to_vec_pretty(&tabs)?)?;
        }
    }
    Ok(())
}

/// Whether a session still holds a note that waits to move: its delete waits too [D916].
pub(crate) fn holds(dir: &Path) -> bool {
    !all_chats(&dir.join("notes")).is_empty()
        || (fs::read_dir(dir.join("notes"))
            .into_iter()
            .flatten()
            .flatten())
        .any(|e| e.path().extension().is_some_and(|x| x == "md"))
}
