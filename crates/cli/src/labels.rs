//! A session's labels, a JSON list of names in its folder's `labels` [D7, D10]. Read, changed and
//! replaced under the session's lock, so two windows' changes at once both stick; adding or
//! removing twice is a no-op. A label lives while some session has it: there's no list of its own.

use crate::{arg, has, index, remove};
use brigadier_core as core;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;

/// `label <id> <name> [--off]`: answers the folder's time after the write, as pin does.
pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let (id, name) = (arg(args, 1)?, arg(args, 2)?.trim());
    if name.is_empty() || name.chars().count() > 40 {
        return Err(io::Error::other("a label is 1 to 40 characters"));
    }
    // So a name can never read as a flag, `--off` above all.
    if name.starts_with('-') {
        return Err(io::Error::other("a label can't start with -"));
    }
    core::load(data, id)?;
    let dir = core::session_dir(data, id);
    let _lock = core::worktrees::lock(&dir)?;
    let path = dir.join("labels");
    let mut labels: Vec<String> = fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let (off, had) = (has(args, "--off"), labels.iter().any(|l| l == name));
    if off && had {
        labels.retain(|l| l != name);
    } else if !off && !had {
        labels.push(name.to_string());
    }
    match labels.is_empty() {
        true => remove(&path)?,
        false => core::write_atomic(&path, &serde_json::to_vec(&labels)?)?,
    }
    Ok(json!({"ok": true, "at": index::touched(&dir)}))
}
