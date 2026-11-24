//! The Mockup tab's ops [D2055, D2070]: the mockup as the tab draws it, the unsent notes Rust keeps
//! so they survive closing the tab, and Send, which steers the notes into the worker's turn as one
//! message and starts the next round [D300]; a worker the user stopped takes none [D96]. And Use,
//! which has the worker wire the pick in and merge it [D2059, D2068, D97].

use super::{LETTERS, WRITING, file, state};
use crate::{owner, workers};
use brigadier_core as core;
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// `mockup <wid> [draft '<notes>' | send '<notes>' | use <letter> '<notes>']`, the notes as the tab keeps them:
/// `{"pins": [{variant, x, y, text, element: {name, file}}], "all": "<a note for all variants>", "round": <the round shown, 1-based>,
/// "cid": "<a send's id, the same on its retries>"}`.
pub(crate) fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let wid = args.get(1).map_or("", String::as_str);
    let notes = |at: usize| -> io::Result<Value> {
        serde_json::from_str(args.get(at).map_or("", String::as_str))
            .map_err(|e| io::Error::other(format!("notes: {e}")))
    };
    match args.get(2).map(String::as_str) {
        None => shown(data, wid),
        Some("draft") => {
            let _one = WRITING.lock().unwrap();
            let mut m = state(data, wid).ok_or_else(none)?;
            m["draft"] = notes(3)?;
            workers::write_json(&file(data, wid), &m)?;
            Ok(json!({"ok": true}))
        }
        Some("send") => send(data, wid, &notes(3)?),
        Some("use") => pick(
            data,
            wid,
            args.get(3).map_or("", String::as_str),
            &notes(4)?,
        ),
        Some(other) => Err(io::Error::other(format!("unknown mockup op {other}"))),
    }
}

/// The lead's card on round `on` (`<wid>-<round>`): its Use is the tab's.
pub(super) fn from_card(data: &Path, lead: &str, on: &str, choice: &str) -> io::Result<Value> {
    let (wid, round) = on.rsplit_once('-').ok_or_else(none)?;
    if workers::link(data, wid).is_none_or(|l| l.parent != lead) {
        return Err(none());
    }
    let Some(letter) = choice.strip_prefix("Use ") else {
        return Ok(
            json!({"ok": false, "error": "invalid", "message": "Pick one of the card's answers."}),
        );
    };
    let r = pick(
        data,
        wid,
        letter,
        &json!({"round": round.parse::<u64>().unwrap_or(0)}),
    )?;
    // Picked in the tab already: the card only stops asking.
    if r["error"] == "picked" {
        super::settle(data, lead, &format!("{}{on}", super::PICK), choice)?;
    }
    Ok(r)
}

/// The lead's card on that round stops asking, answered by `how`.
fn settle_card(data: &Path, wid: &str, round: usize, how: &str) {
    if let Some(l) = workers::link(data, wid) {
        let _ = super::settle(
            data,
            &l.parent,
            &format!("{}{wid}-{round}", super::PICK),
            how,
        );
    }
}

fn none() -> io::Error {
    io::Error::other("No mockup here.")
}

fn stopped(data: &Path, wid: &str) -> bool {
    workers::link(data, wid).is_some_and(|l| l.last["how"] == "stopped")
}

/// A turn runs, or its brief hasn't gone yet; a dev server it left running isn't drawing.
fn working(data: &Path, wid: &str) -> io::Result<bool> {
    let f = core::fold(&core::session_dir(data, wid), true)?.fold;
    Ok(!f.turns.is_empty() || f.cids.is_empty())
}

/// The mockup as the tab draws it (`app/ui/src/mockup/model.ts`): the last round draws while its
/// worker works, the pick builds while it does, and a worker the user stopped.
fn shown(data: &Path, wid: &str) -> io::Result<Value> {
    let mut m = state(data, wid).ok_or_else(none)?;
    let working = working(data, wid)?;
    let picked = m["picked"].is_string();
    // A round with every variant in is drawn, though its worker's turn goes on.
    let drawing = working && !picked && !super::all_in(&m);
    if let Some(last) = m["rounds"].as_array_mut().and_then(|r| r.last_mut()) {
        last["drawing"] = drawing.into();
    }
    m["building"] = (working && picked && m["real"].is_null()).into();
    m["stopped"] = stopped(data, wid).into();
    Ok(m)
}

/// The notes as the one message they go as, the old app's by variant: each numbered as its pin, at
/// its point, with the element it was on, then the note for all variants. None with no notes.
fn message(m: &Value, round: usize, pins: &[Value], all: &str) -> Option<String> {
    if pins.is_empty() && all.is_empty() {
        return None;
    }
    let variants = &m["rounds"][round - 1]["variants"];
    let name = |l: &str| {
        (variants.as_array().into_iter().flatten())
            .find(|v| v["letter"] == l)
            .and_then(|v| v["name"].as_str())
            .unwrap_or("")
            .to_string()
    };
    let pct = |v: &Value| (v.as_f64().unwrap_or(0.0) * 100.0).round();
    let mut blocks = vec![format!(
        "Notes on the mockup (round {round}), numbered as the pins on each variant:"
    )];
    for l in LETTERS {
        let own: Vec<String> = (pins.iter().enumerate())
            .filter(|(_, p)| p["variant"] == l)
            .map(|(i, p)| {
                let on = match (p["element"]["name"].as_str(), p["element"]["file"].as_str()) {
                    (Some(n), Some(f)) => format!(" · on {n} ({f})"),
                    (Some(n), None) => format!(" · on {n}"),
                    _ => String::new(),
                };
                let text = p["text"].as_str().unwrap_or("").trim();
                format!(
                    "{}. (x: {}%, y: {}%) {text}{on}",
                    i + 1,
                    pct(&p["x"]),
                    pct(&p["y"])
                )
            })
            .collect();
        if !own.is_empty() {
            blocks.push(format!("Variant {l} ({}):\n{}", name(l), own.join("\n")));
        }
    }
    if !all.is_empty() {
        blocks.push(format!("For all variants:\n{all}"));
    }
    Some(blocks.join("\n\n"))
}

/// A send's or a Use's notes: the pinned ones and the one for all variants.
fn parts(notes: &Value) -> (Vec<Value>, &str) {
    let pins = notes["pins"].as_array().cloned().unwrap_or_default();
    (pins, notes["all"].as_str().unwrap_or("").trim())
}

/// The round the notes are on, 1-based: the one the tab showed, else the newest.
fn on_round(m: &Value, notes: &Value) -> usize {
    let rounds = m["rounds"].as_array().map_or(0, Vec::len).max(1);
    notes["round"]
        .as_u64()
        .map_or(rounds, |r| (r as usize).clamp(1, rounds))
}

/// Send: the notes go to the worker as the user's one message, steered into a turn that runs
/// [D300]; the round they're on keeps them, read-only, and the next starts [D2070], or, while a
/// newer round still draws, they fold into it. A send that fails leaves the mockup as it was, the
/// notes still the tab's to retry.
fn send(data: &Path, wid: &str, notes: &Value) -> io::Result<Value> {
    let no =
        |error: &str, message: &str| Ok(json!({"ok": false, "error": error, "message": message}));
    let _one = WRITING.lock().unwrap();
    let was = state(data, wid).ok_or_else(none)?;
    if stopped(data, wid) {
        return no(
            "ended",
            "This mockup's worker was stopped. Notes can't be sent.",
        );
    }
    if let Some(p) = was["picked"].as_str() {
        return no(
            "picked",
            &format!("{p} is picked: the mockup takes no more notes."),
        );
    }
    // A retry keeps its id: a send its worker took, whose reply was lost, counts as sent, not twice.
    let cid = notes["cid"].as_str();
    let took = || {
        cid.is_some_and(|c| {
            core::fold(&core::session_dir(data, wid), true)
                .is_ok_and(|f| f.fold.cids.contains_key(c))
        })
    };
    if took() {
        return Ok(json!({"ok": true, "round": was["rounds"].as_array().map_or(1, Vec::len)}));
    }
    let (pins, all) = parts(notes);
    let round = on_round(&was, notes);
    let Some(text) = message(&was, round, &pins, all) else {
        return no("empty", "There are no notes to send.");
    };
    let last = was["rounds"].as_array().map_or(0, Vec::len).max(1);
    // As the tab shows it: a round all in is drawn, though its worker's turn goes on.
    let drawing = (working(data, wid)? && !super::all_in(&was))
        || was["rounds"][last - 1]["variants"]
            .as_array()
            .is_none_or(Vec::is_empty);
    let next = if drawing { last } else { last + 1 };
    let ask = if drawing {
        format!(
            "Fold these into round {next}, the one you draw now, and report each variant again with --round {next}."
        )
    } else {
        format!(
            "Draw round {next}: change the variants as asked, and report each again with --round {next}."
        )
    };
    let text = format!("{text}\n\n{ask}");
    let mut m = was.clone();
    let on = &mut m["rounds"][round - 1];
    if let Some(sent) = on["sent"].as_array_mut() {
        sent.extend(pins.iter().cloned());
    }
    let before = on["all"].as_str().unwrap_or("");
    on["all"] = [before, all]
        .into_iter()
        .filter(|a| !a.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
        .into();
    if next > last
        && let Some(rounds) = m["rounds"].as_array_mut()
    {
        rounds.push(json!({"variants": [], "sent": []}));
    }
    (m["draft"], m["doing"]) = (Value::Null, Value::Null);
    workers::write_json(&file(data, wid), &m)?;
    let mut call: Vec<String> = ["send", wid, &text, "--steer"].map(String::from).into();
    call.extend(
        cid.map(|c| ["--cid".into(), c.into()])
            .into_iter()
            .flatten(),
    );
    let reply =
        crate::run(data, &call).unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}));
    // A reply lost after the worker logged it went all the same [D54].
    if reply["ok"] != true && reply["result"] != "logged" {
        workers::write_json(&file(data, wid), &was)?;
        let why = reply["message"]
            .as_str()
            .or(reply["error"].as_str())
            .unwrap_or("");
        let error = if reply["result"] == "refused" {
            "refused"
        } else {
            "failed"
        };
        return no(error, &format!("Couldn't send the notes: {why}"));
    }
    settle_card(data, wid, round, "Left notes");
    // The lead's chat records it: "You → mockup · 3 notes on A and B · round 2 drawing".
    if let Some(l) = workers::link(data, wid) {
        let mut on: Vec<&str> = LETTERS
            .into_iter()
            .filter(|l| pins.iter().any(|p| p["variant"] == *l))
            .collect();
        if !all.is_empty() {
            on = LETTERS[..was["count"].as_u64().unwrap_or(3).min(3) as usize].to_vec();
        }
        let count = pins.len() + usize::from(!all.is_empty());
        let note = json!({"event": "mockup", "phase": "notes", "id": wid, "count": count, "on": on, "round": next});
        let _ = owner::call(data, &l.parent, json!({"op": "note", "data": note}));
    }
    Ok(json!({"ok": true, "round": next}))
}

/// Use: the pick goes to the worker as one message, after any turn it's in: keep that variant's
/// code and wire it into the real screen, no redraw, delete the others', report the real screen
/// and merge [D2059, D2068, D97]; that turn's end reports to the parent as any task's [D560]. Unsent
/// notes go with it, cleared once it's taken. A worker the user stopped can't: the pick goes to
/// the lead, with the branch its code is on [D560].
pub(super) fn pick(data: &Path, wid: &str, letter: &str, notes: &Value) -> io::Result<Value> {
    let no =
        |error: &str, message: &str| Ok(json!({"ok": false, "error": error, "message": message}));
    let _one = WRITING.lock().unwrap();
    let mut m = state(data, wid).ok_or_else(none)?;
    if let Some(p) = m["picked"].as_str() {
        return no("picked", &format!("{p} is already picked."));
    }
    // The round shown, else the newest that drew it.
    let rounds = m["rounds"].as_array().cloned().unwrap_or_default();
    let shown = notes["round"].is_u64().then(|| on_round(&m, notes));
    let found = rounds
        .iter()
        .enumerate()
        .rev()
        .filter(|(i, _)| shown.is_none_or(|s| s == i + 1))
        .find_map(|(i, r)| {
            let v = r["variants"]
                .as_array()?
                .iter()
                .find(|v| v["letter"] == letter)?;
            Some((i + 1, v["name"].as_str().unwrap_or("").to_string()))
        });
    let Some((round, name)) = found else {
        return no("missing", &format!("There's no variant {letter} to use."));
    };
    let mut link = workers::link(data, wid).ok_or_else(none)?;
    let dir = core::session_dir(data, wid);
    let branch = core::worktrees::branch(&dir)?;
    let (pins, all) = parts(notes);
    let with = message(&m, round, &pins, all).map_or(String::new(), |t| format!("\n\n{t}"));
    let picked = format!("The user picked {letter} ({name}) from round {round} of the mockup");
    let keep = format!(
        "{letter}'s fixture code into the app's real screen as it is, without redrawing it"
    );
    let (to, text) = if stopped(data, wid) {
        let title = m["title"].as_str().unwrap_or("");
        let from = branch
            .as_deref()
            .map_or(String::new(), |b| format!(", from its branch {b}"));
        (
            link.parent.clone(),
            format!(
                "{picked} {title} that worker {wid} drew. The user stopped that worker, so it's yours to build: wire {keep}{from}, and leave the other variants' fixture code out.{with}"
            ),
        )
    } else {
        let into = core::load(data, &link.parent)?.cwd;
        // A folder project's worker has no branch of its own to merge, as at its start.
        let base = core::worktrees::base(&dir);
        let merge =
            (branch.as_deref().zip(base.as_deref())).map(|(b, base)| (into.as_str(), b, base));
        let merge = workers::land_line(merge, !link.review.is_null());
        (
            wid.to_string(),
            format!(
                "{picked}. Wire {keep}, and delete the other variants' fixture code from your branch; keep {letter}'s own fixture page working at its address, for the compare. Once the real screen works in the dev server, report its address with `brigadier mockup --real <url>`. {merge}{with}"
            ),
        )
    };
    // The worker's turn for it reports back when it ends, as a brief's does [D560].
    let cid = crate::control::new_cid();
    let was = link.report.clone();
    if to == wid {
        link.report.push(cid.clone());
        workers::write_json(&dir.join("worker.json"), &link)?;
    }
    let reply = crate::run(data, &["send", &to, &text, "--cid", &cid].map(String::from))
        .unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}));
    if reply["ok"] != true && reply["result"] != "logged" {
        if to == wid {
            link.report = was;
            workers::write_json(&dir.join("worker.json"), &link)?;
        }
        let why = reply["message"]
            .as_str()
            .or(reply["error"].as_str())
            .unwrap_or("");
        return no("failed", &format!("Couldn't send the pick: {why}"));
    }
    (m["picked"], m["pickedRound"], m["draft"]) = (letter.into(), round.into(), Value::Null);
    m["doing"] = Value::Null;
    workers::write_json(&file(data, wid), &m)?;
    settle_card(data, wid, round, &format!("Use {letter}"));
    let message = (to != wid)
        .then(|| format!("{letter} went to the lead to build, as its worker was stopped."));
    Ok(json!({"ok": true, "message": message}))
}
