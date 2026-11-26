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

impl Fold {
    /// Where a turn's agent's own safety check gave no verdict [D455]: "ask" while that turn runs
    /// on Auto, so its next try asks the user; "back" once it ended, however it ended, to the
    /// session's own level. With the turn's id, so each is done once.
    pub fn unchecked(&self) -> Option<(&'static str, &str)> {
        if let Some(t) = self.turns.first() {
            let auto = self.given.as_ref()?["level"] == "auto";
            return (t.unchecked && auto).then_some(("ask", &t.id));
        }
        let last = self.last.as_ref().filter(|l| l["unchecked"] == true)?;
        Some(("back", last["id"].as_str()?))
    }
}

/// A turn its CLI started on its own (a background task's end) after the user's Stop or a Pause,
/// with no message since: who stopped it, so it's stopped again at once [D90, D95].
pub fn woke(fold: &Fold) -> Option<&str> {
    fold.turns
        .first()
        .filter(|t| t.origin == "agent" && !t.stopping)?;
    let last = fold.last.as_ref().filter(|l| l["outcome"] == "stopped")?;
    last["reason"]
        .as_str()
        .filter(|by| matches!(*by, "user" | "pause"))
}

/// Whether a worker waits on the user's call on its row's hold [D2028, D342].
pub fn held(fold: &Fold) -> bool {
    fold.hold.as_ref().is_some_and(|h| h["phase"] == "asked")
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
/// session's limit or refused resume on [D51], so it spins while that switch is on its way. `holding`:
/// `Fold::holding`'s answer.
pub fn mark(
    fold: &Fold,
    live: &Live,
    seen: u64,
    auto: bool,
    holding: bool,
) -> Option<&'static str> {
    let (state, _) = state(fold, live);
    let state = if quiet(fold, state) { "idle" } else { state };
    let ended = fold
        .last
        .as_ref()
        .and_then(|l| l["ts"].as_u64())
        .unwrap_or(0);
    match state {
        "waiting_answer" | "sign_in" => Some("needs"),
        // A mockup card its ended turn left up: between turns still, so its queue and results go in.
        "idle" | "idle_jobs" if !fold.mockups.cards.is_empty() => Some("needs"),
        "logged" | "starting" | "working" | "silent" | "retrying" | "checking" | "asking"
        | "reconnecting" => Some("working"),
        // Its answer is in, but the block stays open on its subagents or workers: still working [D118, D151].
        "idle" | "idle_jobs" if holding => Some("working"),
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

/// How many times Brigadier resumes a turn the network cut, by itself, before Try again [D339].
pub const RECONNECTS: u64 = 3;

/// The resume due for a last turn a passing failure ended (no connection, busy servers, a timeout)
/// [D339]: its command id, one per try, so a repeat or a racing pass finds it logged; which try;
/// the turn it carries on. `now`: the user's Try again, past the tries or a Stop.
pub fn reconnect(fold: &Fold, now: bool) -> Option<Value> {
    let last = fold.last.as_ref().filter(|_| fold.turns.is_empty())?;
    // A summary turn's failure isn't carried on: its renewal goes ahead without it [rev 3 §4].
    if last["outcome"] != "failed"
        || last["origin"] == "summary"
        || !adapters::temporary(last["why"].as_str()?)
        || (last["halted"] == true && !now)
    {
        return None;
    }
    let cid = last["cid"].as_str().or(last["id"].as_str())?;
    let (root, n) = match cid.rsplit_once(".n").map(|(r, n)| (r, n.parse::<u64>())) {
        Some((root, Ok(n))) => (root, n),
        _ => (cid, 0),
    };
    (now || n < RECONNECTS).then(|| {
        json!({"cid": format!("{root}.n{}", n + 1), "attempt": n + 1, "max": RECONNECTS,
               "turn": last["id"], "of": cid, "backend": last["backend"]})
    })
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
        "waiting_answer" if turn.is_none() => {
            let id = fold.hold.as_ref()?["id"].as_str()?;
            ("question", format!("ask:{id}"), None)
        }
        "waiting_answer" => {
            let turn = turn?;
            match turn.asks.iter().find(|(_, r)| r["to"].is_null()) {
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
        // A rewind drops the last end (`last` None): no turn ended, so nothing is told again.
        _ if turn.is_some() || fold.finished == 0 || fold.last.is_none() => return None,
        // A quiet turn's end is no news [D119]; a summary's tells the done turn it served, once [D92].
        "idle" | "idle_jobs" if fold.last.as_ref().is_some_and(|l| l["quiet"] == true) => {
            let served = crate::summary::served(fold).filter(|l| l["outcome"] == "done")?;
            ("done", format!("end:{}", served["id"].as_str()?), None)
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
        // A failed summary is no failure of the session's: nothing to try again [rev 3 §4].
        let summary = fold.last.as_ref().is_some_and(|l| l["origin"] == "summary");
        return match () {
            _ if live.owner == Owner::Frozen => ("unresponsive", Value::Null),
            _ if held(fold) => (
                "waiting_answer",
                fold.hold.clone().unwrap_or_default()["why"].clone(),
            ),
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
            _ if outcome == "failed" && reconnect(fold, false).is_some() => {
                ("reconnecting", reconnect(fold, false).unwrap_or_default())
            }
            // A failed turn says so though a job it left runs: its notice, mark and Try again.
            _ if outcome == "failed" && !summary => ("failed", Value::Null),
            _ if live.jobs > 0 => ("idle_jobs", live.jobs.into()),
            _ if outcome == "stopped" => ("stopped", Value::Null),
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
        let acks = turn
            .cid
            .as_ref()
            .is_some_and(|c| fold.acking.contains_key(c));
        let confirm = adapters::get(&turn.backend).map_or(10_000, |a| a.confirm_ms());
        let wait = if acks { confirm } else { 2_000 };
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
    // A request only the user answers waits on them, whatever else its turn waits on [D173].
    if let Some((id, _)) = turn.asks.iter().find(|(_, r)| r["to"].is_null()) {
        let why = turn
            .question
            .clone()
            .map_or(json!({"approval": id}), Value::from);
        return ("waiting_answer", why);
    }
    // Its own mockup card, the call that asked it waiting on the pick; one left up from an earlier
    // turn doesn't hide this one's work.
    if let Some((id, _)) = fold.mockups.cards.iter().find(|(_, t)| *t == turn.id) {
        return ("waiting_answer", json!({"offer": id}));
    }
    // Brigadier answers an exact repeat of a command allowed for the session: it works on [D389].
    if let Some((id, _)) = turn.asks.iter().find(|(_, r)| r["to"] == "brigadier") {
        return ("working", serde_json::json!({"repeat": id}));
    }
    // A plan its review holds: it works on, nobody's to answer yet [§6].
    if let Some((id, _)) = turn.asks.iter().find(|(_, r)| r["to"] == "review") {
        return ("working", serde_json::json!({"review": id}));
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
