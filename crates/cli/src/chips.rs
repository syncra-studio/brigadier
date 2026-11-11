//! `chips <id>`: what waits above a session's composer for the agent, and the comment being
//! written on its diff, kept in its folder so an app restart drops neither [D35, D1040, D1195].
//! A send hands chips to its message first (`take`, by the message's command or queue id, and the
//! session it goes to); a refused send gives them back (`back`). Reading settles any handed-off
//! chip by the logs: its message reached the log or the queue, so it's gone; else it's back. So a
//! crash anywhere neither loses a comment nor sends one twice [D1174]. Every change is safe to
//! send twice and answers the whole state.

use crate::{USAGE, arg, queue};
use brigadier_core::{self as core, worktrees};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;

const FILE: &str = "chips.json";
/// A chip or a draft is a few lines of a comment; anything bigger isn't one.
const MAX: usize = 64 * 1024;

#[derive(Default, Serialize, Deserialize)]
struct Kept {
    /// What the app sent as it is, with its `id`.
    chip: Value,
    /// Handed to a message: its id and the session it went to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    taken: Option<(String, String)>,
}

#[derive(Default, Serialize, Deserialize)]
struct Chips {
    chips: Vec<Kept>,
    #[serde(default)]
    draft: Value,
}

fn json_arg(text: &str) -> io::Result<Value> {
    if text.len() > MAX {
        return Err(io::Error::other("too big for a comment"));
    }
    serde_json::from_str(text).map_err(io::Error::other)
}

/// Whether message `msg` got where it went: in that session's log, or this one's queue. A queue
/// add that's mid-write isn't seen; it lasts microseconds, not a restart.
fn went(data: &Path, id: &str, (msg, into): &(String, String)) -> bool {
    let dir = core::session_dir(data, into);
    let logged = core::fold(&dir, true).is_ok_and(|f| f.fold.cids.contains_key(msg));
    if logged {
        return true;
    }
    if into != id {
        // Send as new: its session exists once it was made, and carries the message from there.
        return dir.exists();
    }
    let q = queue::row(&dir);
    let has = |v: &Value| v["id"].as_str() == Some(msg);
    q["items"]
        .as_array()
        .is_some_and(|items| items.iter().any(has))
        || has(&q["editing"])
}

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    let dir = core::session_dir(data, id);
    if !dir.is_dir() {
        return Err(io::Error::other(format!("no session {id:?}")));
    }
    // A send holds this lock until its message is logged, so a read never settles one under way.
    let _lock = worktrees::lock(&dir)?;
    let path = dir.join(FILE);
    let was = fs::read(&path).unwrap_or_default();
    let mut state: Chips = serde_json::from_slice(&was).unwrap_or_default();
    let ids = || args.iter().skip(3).map(String::as_str);
    match args.get(2).map(String::as_str) {
        None => state.chips.retain_mut(|kept| match &kept.taken {
            Some(taken) if went(data, id, taken) => false,
            _ => {
                kept.taken = None;
                true
            }
        }),
        Some("add") => {
            let chip = json_arg(arg(args, 3)?)?;
            let Some(chip_id) = chip["id"].as_str() else {
                return Err(io::Error::other("a chip needs an id"));
            };
            if !state.chips.iter().any(|kept| kept.chip["id"] == chip_id) {
                state.chips.push(Kept { chip, taken: None });
            }
        }
        Some("drop") => state
            .chips
            .retain(|kept| !ids().any(|each| kept.chip["id"] == each)),
        Some("take") => {
            let msg = arg(args, 3)?.to_string();
            core::check_id(&msg)?;
            let (into, from) = match args.get(4).map(String::as_str) {
                Some("--in") => (arg(args, 5)?.to_string(), 6),
                _ => (id.to_string(), 4),
            };
            core::check_id(&into)?;
            let wanted: Vec<&str> = args.iter().skip(from).map(String::as_str).collect();
            for kept in &mut state.chips {
                let mine = wanted.iter().any(|each| kept.chip["id"] == *each);
                if mine && kept.taken.is_none() {
                    kept.taken = Some((msg.clone(), into.clone()));
                }
            }
        }
        Some("back") => {
            let msg = arg(args, 3)?;
            for kept in &mut state.chips {
                if kept.taken.as_ref().is_some_and(|(m, _)| m == msg) {
                    kept.taken = None;
                }
            }
        }
        Some("draft") => {
            state.draft = match arg(args, 3)? {
                "-" => Value::Null,
                text => json_arg(text)?,
            }
        }
        Some(_) => return Err(io::Error::other(USAGE)),
    }
    let now = serde_json::to_vec(&state)?;
    if now != was {
        core::write_atomic(&path, &now)?;
    }
    let waiting: Vec<&Value> = (state.chips.iter())
        .filter(|kept| kept.taken.is_none())
        .map(|kept| &kept.chip)
        .collect();
    Ok(json!({"ok": true, "chips": waiting, "draft": state.draft}))
}
