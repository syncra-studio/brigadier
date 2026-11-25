//! The turn-end check for an agent whose CLI has no hook that runs it [D529]: a reply that asks
//! the user in prose goes back to its agent once, as Brigadier's own words, which the thread
//! folds into the same block with no bubble [D510, D521].

use brigadier::queue;
use brigadier_core::{self as core, rules};
use brigadier_frames::log::now_ms;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::thread;

/// A session's turn just ended: judged off the daemon's loop.
pub fn turn_ended(data: &Path, id: &str) {
    let (data, id): (PathBuf, String) = (data.into(), id.into());
    thread::spawn(move || check(&data, &id));
}

fn check(data: &Path, id: &str) -> Option<()> {
    let dir = core::session_dir(data, id);
    let f = core::fold(&dir, true).ok()?.fold;
    let last = f.last.as_ref().filter(|_| f.turns.is_empty())?;
    let turn = last["id"].as_str()?;
    // Only a turn that ended well just now: the daemon's first pass sees every session's last.
    if last["outcome"] != "done" || now_ms().saturating_sub(last["ts"].as_u64()?) > 120_000 {
        return None;
    }
    let counts: Value =
        serde_json::from_slice(&std::fs::read(dir.join("rules.json")).unwrap_or_default())
            .unwrap_or_default();
    // Judged already, here or inside the turn by its agent's own hook.
    if counts["judged"] == turn || counts["judged"]["hook"] == last["backend"] {
        return None;
    }
    let reply = last["reply"].as_str().unwrap_or("");
    let retry = last["origin"] == "system" && last["text"] == rules::SEND_BACK;
    let hit = rules::asks_in_prose(reply);
    // A worker's last words go to its lead as its result, a question included.
    let sent = hit
        && !core::overnight::load(&dir).night()
        && !retry
        && !core::load(data, id).is_ok_and(|s| s.naked)
        && queue::send_back(data, id, turn, rules::SEND_BACK).unwrap_or(false);
    rules::count(&dir, reply, hit, sent, retry, turn.into());
    Some(())
}
