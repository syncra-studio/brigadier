//! A session's state from its fold and the kernel: the status the app shows, whether a switch can
//! act, and whether it keeps the Mac awake.

use super::{Fold, Live};
use crate::adapters;
use serde_json::{Value, json};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Owner {
    Alive,
    Dead,
    /// Holds the lock but is stopped or not answering: can't tell, so it is never replaced.
    Frozen,
}

pub fn status(fold: &Fold, live: &Live) -> Value {
    let (state, reason) = state(fold, live);
    let turn = fold.turns.first().map(|t| json!({"cid": t.cid, "origin": t.origin, "backend": t.backend, "delivered": t.delivered.is_some(), "began": t.began, "tools": t.tools.len()}));
    let undelivered: Vec<_> = fold
        .turns
        .iter()
        .filter(|t| t.delivered.is_none())
        .map(|t| t.cid.clone())
        .collect();
    let dups = fold.cids.values().filter(|&&n| n > 1).count();
    json!({"state": state, "reason": reason, "turn": turn, "last": fold.last, "owner": format!("{:?}", live.owner).to_lowercase(),
           "child": live.child.map(|c| c.pid), "jobs": live.jobs, "helpers": live.running_below, "orphans": live.orphans, "disk_full": live.disk_full,
           "undelivered": undelivered, "dup_cids": dups, "unknown": fold.unknown, "compactions": fold.compactions,
           "items": fold.items, "backend": fold.backend, "resume": fold.resume, "versions": fold.versions,
           "account": fold.accounts.get(&fold.backend), "switchable": switchable(fold)})
}

/// What a switch can act on [D51]: the limit (or refused resume) the last turn ended on, even with
/// the terminal open, which the state would show first [D47]. Only while no turn is open.
pub fn switchable(fold: &Fold) -> Option<&'static str> {
    if !fold.turns.is_empty() {
        return None;
    }
    match () {
        _ if fold.limit.is_some() => Some("limited"),
        _ if fold.refused.is_some() => Some("unresumable"),
        _ => None,
    }
}

/// Whether this session keeps the Mac awake [D30, D36]: background jobs its live agent left running,
/// or a delivered turn whose live agent is starting, has fresh output or runs a tool, in chat or in a
/// terminal alike. A turn waiting on the user, or quiet past its stall time, doesn't, so a hung CLI
/// can't keep a Mac awake in a bag.
pub fn works(fold: &Fold, live: &Live) -> bool {
    if live.owner != Owner::Alive {
        return false;
    }
    if live.jobs > 0 {
        return true;
    }
    let (Some(turn), Some(child)) = (fold.turns.first(), live.child) else {
        return false;
    };
    let waiting = child.stopped || turn.question.is_some();
    let Some(delivered) = turn.delivered.filter(|_| !waiting) else {
        return false;
    };
    let t = adapters::get(&turn.backend).map(|a| a.timing());
    let quiet_ms = t.map_or(30_000, |t| [t.no_start_ms, t.stall_ms][turn.began as usize]);
    let silence = live.now.saturating_sub(fold.last_out.max(delivered));
    silence < quiet_ms || (!turn.tools.is_empty() && live.running_below > 0)
}

/// How long after a limit an automatic switch counts as on its way; one not made by then found
/// nowhere to go, and the session is stuck [D51].
const SWITCH_GRACE_MS: u64 = 10_000;

/// A row's one mark [D173], from the fold's facts: "working", "needs" (you), "amber" (failed or
/// stuck), "unread" (a turn ended after `seen`), or none. `auto` says an automatic switch takes this
/// session's limit or refused resume on [D51], so it spins while that switch is on its way.
pub fn mark(fold: &Fold, live: &Live, seen: u64, auto: bool) -> Option<&'static str> {
    let (state, _) = state(fold, live);
    let ended = fold
        .last
        .as_ref()
        .and_then(|l| l["ts"].as_u64())
        .unwrap_or(0);
    match state {
        "waiting_answer" | "sign_in" => Some("needs"),
        "logged" | "starting" | "working" | "silent" | "idle_jobs" => Some("working"),
        // Mid-turn in the terminal it works; between turns the terminal is only open [D47].
        "terminal" if !fold.turns.is_empty() => Some("working"),
        "limited" | "unresumable" if auto && live.now.saturating_sub(ended) < SWITCH_GRACE_MS => {
            Some("working")
        }
        "failed" | "interrupted" | "undelivered" | "unresumable" | "limited" | "stalled"
        | "unresponsive" | "no_turn_started" => Some("amber"),
        // The user's own stop: nothing to tell them, as in the old app.
        "stopped" => None,
        _ if fold.finished > seen => Some("unread"),
        _ => None,
    }
}

fn state(fold: &Fold, live: &Live) -> (&'static str, Value) {
    let Some(turn) = fold.turns.first() else {
        let outcome = fold
            .last
            .as_ref()
            .and_then(|l| l["outcome"].as_str())
            .unwrap_or("");
        return match () {
            _ if live.owner == Owner::Frozen => ("unresponsive", Value::Null),
            // An open terminal between turns, whatever the last chat turn's outcome was [D47].
            _ if live.child.is_some() && fold.child.as_ref().is_some_and(|c| c.pty) => {
                ("terminal", Value::Null)
            }
            _ if fold.sign_in.is_some() => ("sign_in", fold.sign_in.clone().into()),
            _ if fold.limit.is_some() => ("limited", fold.limit.clone().into()),
            _ if fold.refused.is_some() => ("unresumable", fold.refused.clone().into()),
            _ if outcome == "interrupted" => (
                "interrupted",
                fold.last.clone().unwrap_or_default()["reason"].clone(),
            ),
            _ if live.jobs > 0 => ("idle_jobs", live.jobs.into()),
            _ if outcome == "stopped" => ("stopped", Value::Null),
            _ if outcome == "failed" => ("failed", Value::Null),
            _ if fold.items == 0 => ("new", Value::Null),
            _ => ("idle", Value::Null),
        };
    };
    let timing = adapters::get(&turn.backend)
        .map(|a| a.timing())
        .unwrap_or(adapters::Timing {
            silent_ms: 20_000,
            stall_ms: 120_000,
            no_start_ms: 30_000,
        });
    let Some(delivered) = turn.delivered else {
        let young = live.now.saturating_sub(turn.ts) < 2_000
            && live.owner == Owner::Alive
            && !turn.orphaned;
        return if young {
            ("logged", Value::Null)
        } else {
            ("undelivered", turn.cid.clone().into())
        };
    };
    if live.owner == Owner::Dead {
        return (
            "interrupted",
            json!({"owner_gone": true, "orphans": live.orphans}),
        );
    }
    if live.owner == Owner::Frozen {
        return ("unresponsive", Value::Null);
    }
    let Some(child) = live.child else {
        return ("interrupted", json!({"child_gone": true}));
    };
    if child.stopped {
        return ("stalled", json!({"stopped": child.pid}));
    }
    // Also in a terminal: the CLI waits on the user either way [D77].
    if let Some(q) = &turn.question {
        return ("waiting_answer", q.clone().into());
    }
    let silence = live.now.saturating_sub(fold.last_out.max(delivered));
    if fold.child.as_ref().is_some_and(|c| c.pty) {
        return ("terminal", json!({"quiet_ms": silence}));
    }
    if !turn.began {
        return if silence > timing.no_start_ms {
            ("no_turn_started", silence.into())
        } else {
            ("starting", silence.into())
        };
    }
    if silence < timing.silent_ms {
        return ("working", Value::Null);
    }
    if !turn.tools.is_empty() && live.running_below > 0 {
        return (
            "working",
            json!({"tool_running": true, "silent_ms": silence}),
        );
    }
    if silence < timing.stall_ms {
        ("silent", silence.into())
    } else {
        ("stalled", json!({"silent_ms": silence}))
    }
}
