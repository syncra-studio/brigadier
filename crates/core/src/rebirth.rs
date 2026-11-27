//! Rebirth [D88, D108, D113; repo-merge D86, D88]: no CLI compacts on its own, so once a conversation's context passes
//! its threshold Brigadier carries the session on in a fresh conversation of the same agent,
//! account, model and effort, started from the hand-off. A turn that ended past it rebirths with
//! the next input; a running one is stopped once no tool runs, and one whose window filled
//! rebirths at once ("cut"). With summaries on, the old conversation first writes one in a
//! tool-free turn, which the renewal carries [repo-merge D92; rev 3 §2.2].

use crate::fold::Fold;
use crate::{Spec, as_run};
use serde_json::{Value, json};

/// Whether agents get their CLI's to-do tool, whose list the hand-off carries [D104, D116];
/// `BRIGADIER_NO_TODO` turns it off for the drill's comparison.
pub fn todo() -> bool {
    std::env::var_os("BRIGADIER_NO_TODO").is_none()
}

/// The context a conversation is reborn at: 250k tokens, or 75% of a smaller window, whichever comes
/// first [D113; repo-merge D86, D88].
/// `BRIGADIER_REBIRTH_AT` sets it for the drill.
pub fn threshold(window: Option<u64>) -> u64 {
    if let Some(at) = std::env::var("BRIGADIER_REBIRTH_AT")
        .ok()
        .and_then(|v| v.parse().ok())
    {
        return at;
    }
    window.map_or(250_000, |w| (w / 4 * 3).min(250_000))
}

/// The backend the session runs on now.
pub fn backend<'a>(spec: &'a Spec, f: &'a Fold) -> &'a str {
    match f.backend.as_str() {
        "" => &spec.backend,
        b => b,
    }
}

/// The window its model's list gives, for a CLI that doesn't say it in its events: the last check
/// Brigadier kept for this folder. `model`, else the one `b` runs.
fn listed(spec: &Spec, f: &Fold, b: &str, model: Option<&str>) -> Option<u64> {
    let model = model.map(String::from).or(as_run(spec, f, b, None).model)?;
    // The check this folder reads, as the pickers do (checked.rs) [C27].
    let check = crate::checked::kept(&crate::data_of(spec), b, std::path::Path::new(&spec.cwd))?;
    let models = check["models"].as_array()?;
    models.iter().find(|m| m["id"] == model.as_str())?["window"].as_u64()
}

/// A context reading, `{used, window, start}`: the window kept from an earlier one where its CLI
/// leaves it out, and `start` its conversation's first reading, so one that began past its
/// threshold isn't reborn again and again. A renewal's conversation also keeps what Brigadier sent
/// it, whether it's a redo, and its `overhead`: what its CLI added by itself [§2.6].
pub fn reading(was: Option<&Value>, item: &Value) -> Value {
    let was = was.cloned().unwrap_or_default();
    let first = was["start"].is_null();
    let start = if first { &item["used"] } else { &was["start"] };
    let window = item["window"]
        .as_u64()
        .map_or(was["window"].clone(), Value::from);
    let mut c = json!({"used": item["used"], "window": window, "start": start,
        "sent": was["sent"], "redo": was["redo"], "overhead": was["overhead"]});
    if let Some(sent) = was["sent"].as_u64().filter(|_| first) {
        c["overhead"] = (item["used"].as_u64().unwrap_or(0).saturating_sub(sent)).into();
    }
    c
}

/// The renewal line of the conversation's window, as the fold last read it.
pub fn line(spec: &Spec, f: &Fold) -> u64 {
    let c = f.context.clone().unwrap_or_default();
    threshold(
        c["window"]
            .as_u64()
            .or_else(|| listed(spec, f, backend(spec, f), None)),
    )
}

/// The renewal line a fresh conversation on `to` starts under, on `model` where one was picked:
/// this one's for the same agent and model, else the picked model's window in its list.
pub fn line_to(spec: &Spec, f: &Fold, to: &str, model: Option<&str>) -> u64 {
    let runs = as_run(spec, f, to, None).model;
    match to == backend(spec, f) && model.is_none_or(|m| runs.as_deref() == Some(m)) {
        true => line(spec, f),
        false => threshold(listed(spec, f, to, model)),
    }
}

/// Whether the conversation has passed its threshold, having begun below it.
pub fn full(spec: &Spec, f: &Fold) -> bool {
    let Some(c) = &f.context else {
        return false;
    };
    let at = line(spec, f);
    // One that began past it can't get smaller by starting again [D88], but for one redo with
    // the overhead it measured: a redo isn't renewed again by this rule [§2.6].
    let began = c["start"].as_u64().unwrap_or(0) < at || c["redo"] != true;
    c["used"].as_u64().is_some_and(|u| u >= at) && began
}

/// Why the session needs a rebirth on its own, now: "cut" for a running turn past its threshold
/// with no tool running and no message under way (it's stopped first) or a last turn the window
/// refused; "switch" for a running turn whose model or agent the user picked another of, or the
/// turn cut for that [D124]; "stall" for a running turn past it that the guard stops instead [D144]; none
/// otherwise. A stopped or paused session is left as the user left it.
pub fn due(spec: &Spec, f: &Fold) -> Option<&'static str> {
    if let Some(t) = f.turns.first() {
        // A summary turn is never cut: its own minutes bound it, then it's "late" [rev 3 §2.2]. A
        // tool it called got past the veto, open or done since the last look: it's stopped at
        // once, as a second line [§4].
        if t.origin == "summary" {
            let ran = brigadier_frames::log::now_ms().saturating_sub(t.ts);
            let late = ran > crate::summary::LIMIT.as_millis() as u64 || t.first_tool > 0;
            return late.then_some("late");
        }
        // A safe point: no tool runs, nothing waits on the user, and no turn its CLI queued
        // behind it would be stopped with it.
        let calm = !t.stopping && t.question.is_none() && t.began;
        let calm = calm && t.asks.is_empty() && f.turns.len() == 1;
        // A stricter level, picked, held or a night ended, doesn't wait for the running tool [D166, C39].
        if calm && switching(spec, f, &t.backend) && (t.tools.is_empty() || stricter(spec, f, t)) {
            return Some("switch");
        }
        let idle = calm && t.tools.is_empty();
        // A message under way may be the reply that ends the turn: a cut waits for a step or the end.
        let idle = idle && !t.replying;
        return (idle && full(spec, f)).then_some(match again(f, &t.id, &t.switch, t.moved) {
            true => "cut",
            false => "stall",
        });
    }
    // The last turn: the window refused it, Brigadier stopped it for this, or this rebirth's own
    // input provably never reached a CLI; one that may have, isn't sent twice [D54]. The user's
    // Continue carries a stalled one on.
    let last = f.last.as_ref()?;
    // Its summary turn ended, however: a cut or a Switch now renews at once, said before it or
    // while it ran; a turn ended done or an agent picked between turns at the next message.
    if let Some(r) = f.renewing.as_ref().filter(|r| r["turn"] == last["id"]) {
        let now = f.picked.as_ref().is_some_and(|p| p.now).then_some("switch");
        let why = ["cut", "switch"].into_iter().find(|w| r["why"] == *w);
        return why.or(now);
    }
    // A cut its turn beat by ending on its own is none: it rebirths at the next message [D108].
    let stopped = f.cut.as_deref() == last["id"].as_str() && last["outcome"] != "done";
    if stopped && f.switched {
        return Some("switch");
    }
    // A turn ended done past its line, or another agent picked, writes its summary at once while
    // the user reads; not one a summary turn was, nor one whose renewal the user stopped [D92].
    let other = f
        .picked
        .as_ref()
        .is_some_and(|p| p.backend != backend(spec, f));
    if (other || last["outcome"] == "done" && full(spec, f))
        && last["origin"] != "summary"
        && crate::summary::runs(f, last)
        && crate::summary::applies(spec, f)
    {
        return Some("summary");
    }
    let refused = last["outcome"] == "failed" && last["why"] == "context" && again_last(f, last);
    let lost = last["switch"]["why"] == "cut" && last["never_ran"] == true;
    let going = f.go_on.is_some() && f.go_on.as_deref() == last["id"].as_str();
    (refused || stopped || lost || going).then_some("cut")
}

/// Whether the session's level, its project's trust included, is stricter than the one the
/// running turn was given: the user's pick, an untrusted project and a night's end alike [C16, C39].
fn stricter(spec: &Spec, f: &Fold, t: &crate::fold::Turn) -> bool {
    let rank = |l: Option<&str>| ["ask", "auto", "full"].iter().position(|x| Some(*x) == l);
    let held = crate::projects::held(&crate::data_of(spec), spec);
    let now = crate::adapters::get(&t.backend).and_then(|a| crate::level(spec, a, held).ok());
    let given = rank(f.given.as_ref().and_then(|g| g["level"].as_str()));
    !t.unchecked && rank(now.flatten()).zip(given).is_some_and(|(o, g)| o < g)
}

/// Whether the user picked another agent and said Switch now [D557], or another model of `backend`
/// than the running turn was given [D124], or a level its agent couldn't take mid-turn
/// (`send::relevel`) [D166]. Another agent picked otherwise waits for the turn's end.
fn switching(spec: &Spec, f: &Fold, backend: &str) -> bool {
    let model = as_run(spec, f, backend, None).model;
    let held = || crate::projects::held(&crate::data_of(spec), spec);
    let level = || crate::adapters::get(backend).and_then(|a| crate::level(spec, a, held()).ok());
    f.picked.as_ref().is_some_and(|p| p.now)
        || (f.given.as_ref()).is_some_and(|g| {
            g["model"].as_str() != model.as_deref()
                // Asking where its check gave no verdict is no switch: it goes back as the turn ends [D455].
                || (!f.turns.first().is_some_and(|t| t.unchecked) && level().is_some_and(|l| g["level"].as_str() != l))
        })
}

/// The fresh conversations in a row, this turn's the last, that a cut began and that did nothing
/// new: no edit, nor a command that does more than look and wasn't run since the last message,
/// nor a reply [D144]. The user's Continue starts it over.
fn empty(f: &Fold, id: &str, switch: &Value, moved: bool) -> u64 {
    let n = switch["empty"].as_u64().unwrap_or(0);
    let going = f.go_on.as_deref() == Some(id);
    if switch["why"] == "cut" && !moved && !going {
        n + 1
    } else {
        0
    }
}

/// Whether this turn may be cut for a rebirth: it isn't the second empty fresh conversation in a
/// row, which would only fill its context again [D144].
pub fn again(f: &Fold, id: &str, switch: &Value, moved: bool) -> bool {
    empty(f, id, switch, moved) < 2
}

/// The same, of the last turn.
pub fn again_last(f: &Fold, last: &Value) -> bool {
    let id = last["id"].as_str().unwrap_or("");
    again(f, id, &last["switch"], last["moved"] == true)
}

/// The guard stopped the last turn: Continue carries it on [D144].
pub fn stalled(f: &Fold) -> bool {
    let last = f.last.as_ref().filter(|_| f.turns.is_empty());
    last.is_some_and(|l| !again_last(f, l))
}

/// Whether the running turn, its window full, goes on in a fresh conversation.
pub fn goes_on(f: &Fold) -> bool {
    f.turns
        .first()
        .is_some_and(|t| again(f, &t.id, &t.switch, t.moved))
}

/// The switch a rebirth's input carries: the same agent, account, model, effort and speed, in a
/// fresh conversation [D88]; the estimate of the first message `sent`, and `redo` when the one it
/// ends began past its line [§2.6].
pub fn record(spec: &Spec, f: &Fold, why: &str, sent: &str) -> Value {
    let c = f.context.clone().unwrap_or_default();
    let redo = c["start"].as_u64().is_some_and(|s| s >= line(spec, f));
    let b = backend(spec, f);
    let run = as_run(spec, f, b, None);
    // A cut carries the guard's count on; the user's message starts it over. One whose input
    // never ran keeps the count it had.
    let last = (crate::summary::served(f).or(f.last.clone())).unwrap_or_default();
    let empty = match last["never_ran"] == true {
        true => last["switch"]["empty"].as_u64().unwrap_or(0),
        false => empty(
            f,
            last["id"].as_str().unwrap_or(""),
            &last["switch"],
            last["moved"] == true,
        ),
    };
    let empty = (why == "cut").then_some(empty);
    json!({"why": why, "fresh": true, "auto": true, "empty": empty,
        "sent": crate::handoff::estimate::tokens(sent), "redo": redo,
        "to": {"backend": b, "account": f.accounts.get(b).map_or("", String::as_str),
               "model": run.model, "effort": run.effort, "fast": run.fast}})
}
