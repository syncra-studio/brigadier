//! A session's state from its fold and the kernel: the status the app shows, whether a switch can
//! act, and whether it keeps the Mac awake.

use super::{Fold, Live};
use crate::adapters;
use serde_json::{Value, json};
use std::borrow::Cow;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Owner {
    Alive,
    Dead,
    /// Holds the lock but is stopped or not answering: can't tell, so it is never replaced.
    Frozen,
}

pub fn status(fold: &Fold, live: &Live) -> Value {
    let (state, reason) = state(fold, live);
    let mut fold = Cow::Borrowed(fold);
    if state == "interrupted" && !fold.turns.is_empty() {
        fold.to_mut().interrupt(reason.clone(), live.now);
    }
    let fold = fold.as_ref();
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

/// The last turn ended on the user's Stop and nothing ran since, background jobs or not: Resume
/// carries it on [D373, D2004].
pub fn resumable(fold: &Fold, state: &str) -> bool {
    matches!(state, "stopped" | "idle_jobs")
        && fold.turns.is_empty()
        && (fold.last.as_ref())
            .is_some_and(|l| l["outcome"] == "stopped" && l["reason"] != "handoff")
}

/// What a switch can act on [D51]: the limit (or refused resume) the last turn ended on. Only
/// while no turn is open.
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
/// or a delivered turn whose live agent is starting, has fresh output or runs a tool. A turn waiting on the user, or quiet past its stall time, doesn't, so a hung CLI
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
    // Only the waiting turn's own share: background jobs counted above still keep it awake.
    let waiting = child.stopped || turn.question.is_some() || !turn.asks.is_empty();
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
    let state = if quiet(fold, state) { "idle" } else { state };
    let ended = fold
        .last
        .as_ref()
        .and_then(|l| l["ts"].as_u64())
        .unwrap_or(0);
    match state {
        "waiting_answer" | "sign_in" => Some("needs"),
        "logged" | "starting" | "working" | "silent" | "retrying" | "checking" | "asking" => {
            Some("working")
        }
        // Its answer is in, but the block stays open on its subagents: still working [D118].
        "idle" | "idle_jobs" if !fold.agents.is_empty() && live.child.is_some() => Some("working"),
        // The agent is done; what it left running is only a calm mark [D68, D105].
        "idle_jobs" if fold.finished > seen => Some("unread"),
        "idle_jobs" => Some("background"),
        "limited" | "out_of_credits" | "unresumable"
            if auto && live.now.saturating_sub(ended) < SWITCH_GRACE_MS =>
        {
            Some("working")
        }
        "failed" | "interrupted" | "undelivered" | "uncertain" | "unresumable" | "limited"
        | "out_of_credits" | "stalled" | "unresponsive" | "no_turn_started" => Some("amber"),
        // The user's own stop: nothing to tell them, as in the old app.
        "stopped" => None,
        _ if fold.finished > seen => Some("unread"),
        _ => None,
    }
}

/// Whether a quiet turn runs, its parent handling a worker's ask: it shows as idle [D119].
pub fn quiet(fold: &Fold, state: &str) -> bool {
    fold.turns.first().is_some_and(|t| t.quiet)
        && matches!(
            state,
            "logged" | "starting" | "working" | "silent" | "retrying" | "checking" | "asking"
        )
}

/// What a row has to tell the user once, as a notice [D200, D2004]: it needs them (a question, an
/// approval, a sign-in), or its last turn ended, done or failed. `id` names that one occasion and
/// reads the same each time, so a reconnect or a new daemon never repeats it. The user's own stop
/// says nothing.
pub fn notice(fold: &Fold, state: &str) -> Option<Value> {
    let turn = fold.turns.first();
    let (kind, id, text) = match state {
        "waiting_answer" => {
            let turn = turn?;
            match turn.asks.iter().find(|(_, r)| r["to"] != "parent") {
                Some((id, ask)) if ask["items"].is_array() => {
                    ("question", format!("ask:{id}"), turn.question.clone())
                }
                Some((id, _)) => ("approval", format!("ask:{id}"), None),
                None => (
                    "question",
                    format!("question:{}", turn.ts),
                    turn.question.clone(),
                ),
            }
        }
        "sign_in" => (
            "sign_in",
            format!("sign_in:{}", fold.finished),
            fold.sign_in.clone(),
        ),
        // A crash ends a turn before any record says so (`status` closes it in a copy); the
        // record written later names the same turn, so it doesn't tell twice.
        "interrupted" if turn.is_some() => ("failed", format!("end:{}", turn?.id), None),
        _ if turn.is_some() || fold.finished == 0 => return None,
        // A quiet turn's end is no news [D119].
        "idle" | "idle_jobs" if fold.last.as_ref().is_some_and(|l| l["quiet"] == true) => {
            return None;
        }
        "idle" | "idle_jobs" => ("done", ended(fold), None),
        "failed" | "interrupted" | "limited" | "out_of_credits" | "unresumable" => (
            "failed",
            ended(fold),
            fold.limit.clone().or(fold.refused.clone()),
        ),
        _ => return None,
    };
    Some(json!({"id": id, "kind": kind, "text": text}))
}

/// The last turn's end, named by that turn (its time for a log older than turn ids).
fn ended(fold: &Fold) -> String {
    match fold.last.as_ref().and_then(|l| l["id"].as_str()) {
        Some(id) if !id.is_empty() => format!("end:{id}"),
        _ => format!("end:{}", fold.finished),
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
            _ if fold.sign_in.is_some() => ("sign_in", fold.sign_in.clone().into()),
            _ if fold.limit.is_some() => (
                if fold.credits {
                    "out_of_credits"
                } else {
                    "limited"
                },
                fold.limit.clone().into(),
            ),
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
        let acks = turn.cid.as_ref().is_some_and(|c| fold.acking.contains(c));
        let wait = if acks {
            crate::send::CONFIRM_WAIT.as_millis() as u64
        } else {
            2_000
        };
        let young =
            live.now.saturating_sub(turn.ts) < wait && live.owner == Owner::Alive && !turn.orphaned;
        // A child's gate opens, and its input is written, only after its `spawned` record: with the
        // owner gone and no such record, the log proves no child read this [D60, D82].
        let never_ran = turn.spawning && (turn.orphaned || live.owner == Owner::Dead);
        return match () {
            _ if young => ("logged", Value::Null),
            // Written to an agent whose own reply never came: it may have taken it [D82, D222].
            _ if acks && !never_ran => ("uncertain", turn.cid.clone().into()),
            _ => ("undelivered", turn.cid.clone().into()),
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
    // Only its parent agent is asked: the user sees it at work [D119].
    if let Some((id, _)) = turn
        .asks
        .iter()
        .next()
        .filter(|_| turn.asks.values().all(|r| r["to"] == "parent"))
    {
        return ("asking", serde_json::json!({"ask": id}));
    }
    if let Some(q) = &turn.question {
        return ("waiting_answer", q.clone().into());
    }
    if let Some(id) = turn.asks.keys().next() {
        return ("waiting_answer", serde_json::json!({"approval": id}));
    }
    // The CLI's own retry while nothing came after it, and its safety hold, say so [D487].
    if turn.retry.is_object() {
        return ("retrying", turn.retry.clone());
    }
    if turn.checking {
        return ("checking", Value::Null);
    }
    let silence = live.now.saturating_sub(fold.last_out.max(delivered));
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
