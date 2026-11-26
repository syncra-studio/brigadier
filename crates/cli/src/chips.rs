//! `chips <id>`: what waits above a session's composer for the agent, and the comment being
//! written on its diff, kept in its folder so an app restart drops neither [D35, D1040, D1195].
//! A send or queue add takes its chips for its message as it goes (`--chips`, attach/book.rs), Send
//! as new first (`take`, by the message's command id, and the session it goes to); a refused one
//! gives them back (`back`). Reading settles any taken chip: while the draft's book has its message
//! on its way it stays its own; else its message reached the log or the queue, so it's gone, or
//! it's back. So a crash anywhere neither loses a comment nor sends one twice [D1174, C58]. Every change is safe to
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
        // Send as new: the source's own log holds its intent, and its result once known [D204].
        // Logged and not refused, it went or is still going; refused, the chip comes back.
        let (mut intent, mut refused) = (false, false);
        let _ = core::read(&core::session_dir(data, id), |item| {
            if item["kind"] == "note" && item["event"] == "side" && item["session"] == into.as_str()
            {
                match item["phase"].as_str() {
                    Some("intent") => intent |= item["cid"] == msg.as_str(),
                    _ => refused = item["ok"] == false,
                }
            }
        });
        return intent && !refused;
    }
    let q = queue::row(&dir);
    let has = |v: &Value| v["id"].as_str() == Some(msg);
    q["items"]
        .as_array()
        .is_some_and(|items| items.iter().any(has))
        || has(&q["editing"])
}

/// Message `msg`'s chips waiting again: the ones it had.
fn untake(state: &mut Chips, msg: &str) -> Vec<Value> {
    let mut back = vec![];
    for kept in &mut state.chips {
        if kept.taken.as_ref().is_some_and(|(m, _)| m == msg) {
            kept.taken = None;
            back.push(kept.chip.clone());
        }
    }
    back
}

/// Changes the chips of session `dir` under their lock, for the draft's book (attach/book.rs).
fn change<T>(dir: &Path, f: impl FnOnce(&mut Chips) -> T) -> io::Result<T> {
    let _lock = worktrees::lock(dir)?;
    let path = dir.join(FILE);
    let was = fs::read(&path).unwrap_or_default();
    let mut state: Chips = serde_json::from_slice(&was).unwrap_or_default();
    let out = f(&mut state);
    let now = serde_json::to_vec(&state)?;
    if now != was {
        core::write_atomic(&path, &now)?;
    }
    Ok(out)
}

/// A refused or discarded message's chips back, as `back` does.
pub(crate) fn back(dir: &Path, msg: &str) -> io::Result<Vec<Value>> {
    change(dir, |state| untake(state, msg))
}

/// Chips `ids` handed to message `msg` of session `into`, by the send or queue add that carries
/// them; one taken already stays its own message's.
pub(crate) fn take(dir: &Path, msg: &str, into: &str, ids: &[&str]) -> io::Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    change(dir, |state| {
        for kept in state.chips.iter_mut().filter(|k| k.taken.is_none()) {
            if ids.iter().any(|each| kept.chip["id"] == *each) {
                kept.taken = Some((msg.into(), into.into()));
            }
        }
    })
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
        None => {
            // Its message still on its way, or its give-back still to bring it back: its own.
            let held = crate::attach::book::holding(&dir);
            state.chips.retain_mut(|kept| match &kept.taken {
                Some((msg, _)) if held.contains(msg) => true,
                Some(taken) if went(data, id, taken) => false,
                _ => {
                    kept.taken = None;
                    true
                }
            })
        }
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
        Some("back") => drop(untake(&mut state, arg(args, 3)?)),
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
