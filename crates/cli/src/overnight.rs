//! Overnight's acts: the user's own (`run`), its agent's (`agent`), and the daemon's pass over
//! each night (`night`). Only the user turns it on, starts the night or ends it; what the agent
//! says is checked and kept here, and the card of the morning is built from that.

pub(crate) mod agent;
mod night;
pub use night::pass;

use crate::{arg, control, flag, owner, queue, workers};
use brigadier_core::overnight::{self as core_night, Before, Overnight, change, load};
use brigadier_core::{self as core, adapters, session};
use brigadier_frames::log;
use serde_json::{Value, json};
use std::io;
use std::path::Path;

fn no(why: &str) -> io::Error {
    io::Error::other(why)
}

/// `overnight <id> on|start|off [--op OP]`, the app's alone.
pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let (id, act, op) = (arg(args, 1)?, arg(args, 2)?, flag(args, "--op"));
    let spec = core::load(data, id)?;
    match act {
        "on" => on(data, &spec, op)?,
        "start" => start(data, &spec, op)?,
        "off" => {
            change(&spec.dir, |o| {
                o.op = op.map(String::from);
                match o.night() {
                    true => end(o, true, None),
                    false => o.state.clear(),
                }
                Ok(())
            })?;
            queue::wake::now();
            settle(data, id)?;
        }
        _ => return Err(no(crate::USAGE)),
    }
    queue::wake::now();
    Ok(json!({"ok": true, "overnight": load(&spec.dir).row(), "op": op}))
}

/// On, its agent not told yet; on already, it stays as it is.
pub(crate) fn on(data: &Path, spec: &core::Spec, op: Option<&str>) -> io::Result<()> {
    if workers::link(data, &spec.id).is_some() {
        return Err(no(
            "Overnight is for the session you talk to, not one it started.",
        ));
    }
    if session::lifecycle(&spec.dir) != (None, Value::Null) {
        return Err(no("This session is archived."));
    }
    change(&spec.dir, |o| {
        if !o.on() {
            let old = std::mem::take(o);
            *o = Overnight {
                state: "asking".into(),
                on: log::now_ms(),
                // What the last night still has to give back or say, and what its morning told.
                before: old.before,
                stop: old.stop,
                notes: old.notes,
                morning: old.morning,
                ..Overnight::default()
            };
        }
        o.op = op.map(String::from);
        Ok(())
    })
}

/// The night begins, at Full access: from here it is `night`'s.
fn start(data: &Path, spec: &core::Spec, op: Option<&str>) -> io::Result<()> {
    if core::projects::held(data, spec) {
        return Err(no(
            "This folder isn’t trusted, so a night can’t run on Full access. Change it in the project’s settings.",
        ));
    }
    let f = core::fold(&spec.dir, true)?.fold;
    let agent = adapters::get(crate::models::next_agent(spec, &f));
    if !agent.is_some_and(|a| a.can().levels.contains(&"full")) {
        return Err(no(
            "This agent has no Full access, so it can’t go overnight.",
        ));
    }
    if session::lifecycle(&spec.dir) != (None, Value::Null) {
        return Err(no("This session is archived."));
    }
    let now = log::now_ms();
    let one = control::held_level(&spec.dir)?;
    let level = core::load(data, &spec.id)?.level;
    let o = load(&spec.dir);
    if o.on() && !o.night() {
        core::rewind::night_starts(data, spec, now);
    }
    let was = change(&spec.dir, |o| {
        if !o.on() {
            return Err(no("Overnight is off. Turn it on first."));
        }
        let was = o.clone();
        o.op = op.map(String::from);
        if o.night() {
            return Ok(was);
        }
        (o.state, o.since) = ("night".into(), now);
        o.before.get_or_insert(Before { level });
        o.full = true;
        o.head = workers::git(&spec.cwd, &["rev-parse", "HEAD"]);
        o.notes
            .push(json!({"id": format!("started:{now}"), "row": {"moment": "started", "at": now}}));
        Ok(was)
    })?;
    drop(one);
    if !was.night()
        && let Err(e) = grant(data, &spec.id)
    {
        change(&spec.dir, |o| {
            if o.night() && o.since == now {
                *o = was;
            }
            Ok(())
        })?;
        return Err(e);
    }
    settle(data, &spec.id)
}

/// Full access, unless the user picked a level meanwhile.
fn grant(data: &Path, id: &str) -> io::Result<()> {
    let dir = core::session_dir(data, id);
    let _one = control::held_level(&dir)?;
    let o = load(&dir);
    if !o.night() || !o.full {
        return Ok(());
    }
    control::relevel(data, id, Some("full".into()))?;
    change(&dir, |o| {
        o.full = false;
        Ok(())
    })
}

/// The level the night took over, given back.
fn give_back(data: &Path, id: &str) -> io::Result<()> {
    let dir = core::session_dir(data, id);
    let _one = control::held_level(&dir)?;
    let (spec, o) = (core::load(data, id)?, load(&dir));
    let Some(before) = o.before.filter(|_| o.state != "night") else {
        return Ok(());
    };
    let full = |level: &Option<String>| level.as_deref() == Some("full");
    if full(&spec.level) {
        control::relevel(data, id, before.level.clone())?;
    }
    // What it started in the night has its Full access too.
    for w in workers::below(data, id).iter().filter(|w| w.at >= o.since) {
        let theirs = core::load(data, &w.wid).is_ok_and(|s| full(&s.level));
        if theirs && !full(&before.level) {
            let _ = control::relevel(data, &w.wid, before.level.clone());
        }
    }
    change(&dir, |o| {
        // Started again meanwhile, it is that night's.
        if !o.night() {
            (o.before, o.full) = (None, false);
        }
        Ok(())
    })
}

/// The night is over: what it did goes to its thread, and its level is still to give back. `user`:
/// they ended it, so its agent stops and no notice tells them.
fn end(o: &mut Overnight, user: bool, why: Option<&str>) {
    let (now, since) = (log::now_ms(), o.since);
    let said = o.report.take().unwrap_or_default();
    let of = match o.items.len() {
        0 => "It had no done list yet.".to_string(),
        all => format!("{} of {all} parts done.", o.done()),
    };
    let summary = match (said.summary.is_empty(), why) {
        (false, _) => said.summary,
        (true, Some(why)) => format!("{why} {of}"),
        (true, None) => of,
    };
    let done: Vec<Value> = (o.items.iter())
        .filter_map(|i| i.proof.as_ref().map(|p| (i, p)))
        .map(|(i, p)| {
            let line = p.text.lines().next().unwrap_or("");
            let more = (p.text.trim() != line.trim()).then_some(&p.text);
            json!({"title": i.title, "proof": format!("{} · {line}", p.by), "more": more})
        })
        .collect();
    let left: Vec<Value> = (o.items.iter())
        .filter(|i| i.proof.is_none())
        .map(|i| match &i.left {
            Some(l) => json!({"title": i.title, "why": l.why, "next": l.next}),
            None if user => json!({"title": i.title, "why": "Not done when you came back"}),
            None => json!({"title": i.title, "why": "Not done when the night ended"}),
        })
        .collect();
    let decided: Vec<Value> = (o.decided.iter())
        .map(|d| json!({"title": d.title, "why": d.why, "other": d.other}))
        .collect();
    o.notes.push(
        json!({"id": format!("report:{since}"), "row": {"moment": "report", "at": now,
        "ms": now.saturating_sub(since), "back": user, "summary": summary, "facts": said.facts, "url": said.url,
        "done": done, "left": left, "decided": decided}}),
    );
    o.morning = Some(core_night::Morning {
        since,
        at: now,
        summary: (!user).then_some(summary),
    });
    o.stop = user;
    o.state.clear();
}

/// What a night still owes: its Full access, its agent and workers stopped, its level given back, its thread told.
/// Each is marked done only once it is, so whatever cut it short, the next pass goes on.
fn settle(data: &Path, id: &str) -> io::Result<()> {
    let spec = core::load(data, id)?;
    let o = load(&spec.dir);
    if o.full && o.night() {
        grant(data, id)?;
    }
    if o.stop {
        if !core::fold(&spec.dir, true)?.fold.turns.is_empty() {
            queue::stop(data, id, "user")?;
        }
        workers::end_all(data, id)?;
        change(&spec.dir, |o| {
            o.stop = false;
            Ok(())
        })?;
    }
    // Before its thread shows it: what comes after isn't the night's.
    if let Some(m) = &o.morning
        && (o.notes.iter()).any(|n| n["id"] == format!("report:{}", m.since))
    {
        core::rewind::night_ends(data, &spec, m.since, m.at);
    }
    if o.before.is_some() && !o.night() {
        give_back(data, id)?;
    }
    // An archived session gets no host: its thread is told once it's back.
    if o.notes.is_empty() || session::lifecycle(&spec.dir) != (None, Value::Null) {
        return Ok(());
    }
    owner::ensure(data, &spec)?;
    for note in &o.notes {
        let mut said = note.clone();
        said["event"] = "overnight".into();
        if owner::call(data, id, json!({"op": "note", "data": said}))?["ok"] != true {
            return Ok(());
        }
        change(&spec.dir, |o| {
            o.notes.retain(|n| n["id"] != note["id"]);
            Ok(())
        })?;
    }
    Ok(())
}

/// The user picked a level by hand: a night has none to give back.
pub(crate) fn picked(dir: &Path) -> io::Result<()> {
    match load(dir).before {
        None => Ok(()),
        Some(_) => change(dir, |o| {
            (o.before, o.full) = (None, false);
            Ok(())
        }),
    }
}

/// Before a session is archived: its night ends as the user's own end does.
pub(crate) fn archived(data: &Path, id: &str) -> io::Result<()> {
    let dir = core::session_dir(data, id);
    let o = load(&dir);
    if !o.on() {
        return Ok(());
    }
    change(&dir, |o| {
        match o.night() {
            true => end(o, true, None),
            false => o.state.clear(),
        }
        Ok(())
    })?;
    settle(data, id)
}

/// The session in its night that `id` is, or works for.
pub(crate) fn of(data: &Path, id: &str) -> Option<String> {
    let mut at = Some(id.to_string());
    while let Some(id) = at {
        if load(&core::session_dir(data, &id)).night() {
            return Some(id);
        }
        at = workers::link(data, &id).map(|l| l.parent);
    }
    None
}

/// What a row says of it: its own fields, and in the night only its morning as news, its workers' too.
pub(crate) fn row(data: &Path, row: &mut Value, o: &Overnight, finished: u64) {
    row["overnight"] = o.row();
    row["overnight_op"] = json!(o.op);
    row["overnight_due"] = o.due().into();
    // Only the user can sign in; what else asks, the night answers.
    if row["notice"]["kind"] == "sign_in" {
        return;
    }
    let asks = matches!(
        row["notice"]["kind"].as_str(),
        Some("question" | "approval")
    );
    let told = |o: &Overnight| !asks && o.morning.as_ref().is_some_and(|m| m.at >= finished);
    if o.night() {
        row["notice"] = Value::Null;
    } else if let Some(m) = o.morning.as_ref().filter(|_| told(o)) {
        let id = format!("overnight:{}", m.since);
        row["notice"] = (m.summary.as_ref()).map_or(
            Value::Null,
            |said| json!({"id": id, "kind": "done", "text": said}),
        );
    } else if row["notice"].is_object() {
        // A worker's, under a session in its night, or of what its morning told already.
        let above = |id: &str| workers::link(data, id).map(|l| l.parent);
        let mut lead = row["id"].as_str().and_then(above);
        while let Some(id) = lead {
            let o = load(&core::session_dir(data, &id));
            if o.night() || told(&o) {
                row["notice"] = Value::Null;
                return;
            }
            lead = above(&id);
        }
    }
}
