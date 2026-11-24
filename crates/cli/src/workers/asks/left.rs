//! A finished worker that left a process running: the user keeps or stops it, on Rust's question
//! card in their own chat, once per finish. Unanswered, it runs on. A mockup's only after the pick.

use crate::relay::mockup;
use crate::workers::{link, place, read_json, write_json};
use crate::{owner, sessions};
use brigadier_core::{self as core, adapters};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const KEEP: &str = "Keep";
const STOP: &str = "Stop";
/// How much of a command the question says, and how many.
const SHOWN: usize = 60;
const NAMED: usize = 3;
/// One write of a `left.json` at a time: the daemon's pass and the user's answer.
static WRITING: Mutex<()> = Mutex::new(());

/// `left.json` in the worker's folder: its newest question.
#[derive(Serialize, Deserialize)]
struct Ask {
    id: String,
    /// The session whose chat it's in.
    to: String,
    /// The finish it's about, when that was.
    at: Value,
    open: bool,
}

fn file(data: &Path, wid: &str) -> PathBuf {
    core::session_dir(data, wid).join("left.json")
}

/// Asks once its finished worker left something running; closes a card nothing is left to decide on.
pub(super) fn pass(data: &Path, wid: &str, row: &Value) {
    let w = &row["worker"];
    let jobs = row["background"].as_array().map_or(&[][..], Vec::as_slice);
    let was = read_json::<Ask>(&file(data, wid));
    let finished = matches!(
        w["kind"].as_str(),
        Some("done" | "doneNotMerged" | "merged")
    ) && row["running"] != true;
    let why = match () {
        _ if jobs.is_empty() => Some("It ended"),
        _ if !finished || was.as_ref().is_some_and(|a| a.at != w["ended"]) => {
            Some("It went back to work")
        }
        _ => None,
    };
    let _one = WRITING.lock().unwrap();
    if let Some(a) = was {
        match why {
            Some(why) if a.open => drop(close(data, wid, a, why)),
            Some(_) if a.at != w["ended"] => {}
            _ => return,
        }
    }
    // Until the pick the user may still compare a mockup's variants.
    let comparing = || mockup::state(data, wid).is_some_and(|m| m["picked"].is_null());
    if finished && !jobs.is_empty() && !comparing() {
        let _ = ask(data, wid, w, jobs);
    }
}

fn ask(data: &Path, wid: &str, w: &Value, jobs: &[Value]) -> io::Result<()> {
    let Some(l) = link(data, wid) else {
        return Ok(());
    };
    let (root, _) = place(data, wid);
    let to = if root == wid { l.parent } else { root };
    let spec = core::load(data, &to)?;
    owner::ensure(data, &spec)?;
    let named: Vec<String> = (jobs.iter().take(NAMED))
        .filter_map(|j| j["label"].as_str())
        .map(|c| match c.char_indices().nth(SHOWN) {
            Some((at, _)) => format!("{}…", &c[..at]),
            None => c.into(),
        })
        .collect();
    let more = match jobs.len().saturating_sub(NAMED) {
        0 => String::new(),
        n => format!(" and {n} more"),
    };
    let text = format!(
        "{} finished and left running: {}{more}. Keep or stop?",
        l.title,
        named.join(" · ")
    );
    let options = json!([
        {"label": KEEP, "description": "It runs on, with Stop in Background processes"},
        {"label": STOP, "description": "Ends what it left running"}]);
    let item = json!({"text": text, "options": options, "recommended": null, "multiSelect": false});
    let id = format!("left-{}-{wid}", &adapters::uuid()[..8]);
    // `held`: its card offers only these answers, no words of the user's and no Skip of its own.
    let request = json!({"id": id, "title": "Left running", "items": [item], "held": true});
    let note = json!({"event": "left", "phase": "asked", "id": id, "request": request});
    let ask = Ask {
        id,
        to,
        at: w["ended"].clone(),
        open: true,
    };
    // Kept first: a crash between asks never, and the card's row still shows what runs.
    write_json(&file(data, wid), &ask)?;
    let sent = owner::call(data, &ask.to, json!({"op": "note", "data": note}));
    if sent.as_ref().is_ok_and(|r| r["ok"] == true) {
        return Ok(());
    }
    std::fs::remove_file(file(data, wid))
}

/// The card shows how it was settled and stops waiting on the user.
fn close(data: &Path, wid: &str, mut ask: Ask, choice: &str) -> io::Result<()> {
    owner::ensure(data, &core::load(data, &ask.to)?)?;
    let note = json!({"event": "left", "phase": "answered", "id": ask.id, "choice": choice});
    owner::call(data, &ask.to, json!({"op": "note", "data": note}))?;
    ask.open = false;
    write_json(&file(data, wid), &ask)
}

/// The user's answer on question `request` in session `id`.
pub(crate) fn answered(data: &Path, id: &str, request: &str, choice: &str) -> io::Result<Value> {
    if ![KEEP, STOP].contains(&choice) {
        return Ok(
            json!({"ok": false, "error": "invalid", "message": "Pick one of the card's answers."}),
        );
    }
    let wid = request.splitn(3, '-').nth(2).unwrap_or("");
    core::check_id(wid)?;
    let _one = WRITING.lock().unwrap();
    let ask = read_json::<Ask>(&file(data, wid)).filter(|a| a.id == request && a.to == id);
    let Some(ask) = ask.filter(|a| a.open) else {
        // Its worker was deleted, and what it left with it.
        let note = json!({"event": "left", "phase": "answered", "id": request, "choice": choice});
        owner::call(data, id, json!({"op": "note", "data": note}))?;
        return Ok(json!({"ok": true}));
    };
    if choice == STOP
        && let Err(e) = sessions::end_jobs(data, wid)
    {
        return Ok(
            json!({"ok": false, "error": "running", "message": format!("Couldn't stop it: {e}.")}),
        );
    }
    close(data, wid, ask, choice)?;
    Ok(json!({"ok": true}))
}
