//! A chat's carry-on once its usage limit has reset, outside a night [C34, C54].

use crate::fold::Fold;
use serde_json::{Value, json};

/// Brigadier's words carrying a chat on once its usage limit has reset [C34]; proposed.
pub const LIMIT_RESET: &str = "[Your usage limit has reset. Carry on from where you stopped. Don't redo anything you already did.]";

/// A chat's carry-on at its usage limit's reset [C34, C54], worked out from its last turn alone:
/// `{cid, due, of, backend}`, its cid `lr<limited end's ms>` (never parsed), due a minute after the
/// reset; or `{held}` where it won't go on by itself: `unknown` (no reset was given), `stuck` (a
/// carry-on that said nothing and whose limit kept its reset), `unconfirmed` (the limited turn's
/// receipt wasn't confirmed: `accepted` asks its CLI, as Recover does [D66, D80]), `unbegun` (a
/// user's message refused before its turn began, its CLI's record not naming it). None at no limit.
pub fn reset_due(f: &Fold, accepted: impl FnOnce(&Value) -> bool) -> Option<Value> {
    let last = f
        .last
        .as_ref()
        .filter(|_| f.turns.is_empty() && f.limit.is_some() && !f.credits)?;
    let Some(resets) = f.resets else {
        return Some(json!({"held": "unknown"}));
    };
    let began = last["began_at"].as_u64().unwrap_or(0);
    let ours = last["cid"].as_str().is_some_and(|c| c.starts_with("lr"));
    let again = ours && last["said"] != true;
    if again && resets <= began {
        return Some(json!({"held": "stuck"}));
    }
    // A user's message the limit refused before its turn began may or may not be in its CLI's
    // conversation, and nothing proves it isn't: never sent again; only its CLI's own record
    // naming it carries it on, else it waits for the user [D66, D74, D80].
    let unbegun = last["began"] == false && last["origin"] == "user";
    if (last["delivered"] != true || unbegun) && !accepted(last) {
        let why = if unbegun { "unbegun" } else { "unconfirmed" };
        return Some(json!({"held": why}));
    }
    let ended = last["ts"].as_u64().unwrap_or(0);
    Some(
        json!({"cid": format!("lr{ended}"), "due": resets.max(ended) + 60_000,
        "of": last["cid"].as_str().or(last["id"].as_str()), "backend": last["backend"]}),
    )
}
