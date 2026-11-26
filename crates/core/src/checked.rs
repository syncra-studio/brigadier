//! Which saved agent check a folder reads [C27]. Each agent's checks are kept per folder in
//! `agents/<name>.json` (`{folder: check}`). A folder's own check, whenever saved, even one that
//! listed nothing or failed: it's what that folder allows. Else the check of the project folder a
//! session's worktree was made from, its same settings. Else home's, marked provisional. Files
//! only: nothing here runs an agent.

use crate::{adapters, projects, worktrees};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

/// A folder's key: its real path where it exists (`/tmp` is `/private/tmp`), else as given less
/// a trailing slash.
pub fn key(cwd: &Path) -> String {
    match fs::canonicalize(cwd) {
        Ok(real) => real.to_string_lossy().into_owned(),
        Err(_) => {
            let s = cwd.to_string_lossy();
            let trimmed = s.trim_end_matches('/');
            if trimmed.is_empty() {
                s.into_owned()
            } else {
                trimmed.to_string()
            }
        }
    }
}

/// The check saved for exactly this folder: under its key, else under the path as given (checks
/// kept before keys were canonical).
pub fn saved(data: &Path, agent: &str, cwd: &Path) -> Option<Value> {
    let path = data.join("agents").join(format!("{agent}.json"));
    let all: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let at = |k: &str| all.get(k).filter(|v| v.is_object()).cloned();
    at(&key(cwd)).or_else(|| at(cwd.to_str()?))
}

/// The check `cwd` reads for `agent`: its own, else its worktree's project folder's (`from:
/// "project"`), else home's (`from: "home"`).
pub fn kept(data: &Path, agent: &str, cwd: &Path) -> Option<Value> {
    if let Some(own) = saved(data, agent, cwd) {
        return Some(own);
    }
    let home = adapters::home_path("");
    let from = |c: Option<Value>, from: &str| {
        c.map(|mut c| {
            c["from"] = from.into();
            c
        })
    };
    let source = source(data, cwd).filter(|s| key(s) != key(cwd));
    (source.and_then(|s| from(saved(data, agent, &s), "project")))
        .or_else(|| (key(&home) != key(cwd)).then(|| from(saved(data, agent, &home), "home"))?)
}

/// The project folder a session's worktree (`<data>/sessions/<id>/worktree`) was made from.
fn source(data: &Path, cwd: &Path) -> Option<PathBuf> {
    let id = cwd.parent()?.file_name()?.to_str()?;
    if cwd.file_name()? != "worktree" || key(&worktrees::path(data, id)) != key(cwd) {
        return None;
    }
    let project = crate::load(data, id).ok()?.project?;
    Some(PathBuf::from(projects::get(data, &project).ok()?.folder))
}
