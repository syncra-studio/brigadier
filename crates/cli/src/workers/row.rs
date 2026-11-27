//! A worker's row facts [D3010, D3012, D3018].

use super::{Link, link, read_json, write_json};
use brigadier_core::{self as core, fold::Fold};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A worker's row facts, for its row [D3010, D3012, D3018]: its parent and brief, its state in
/// a word as the old `workerState`, and its receipt. Null for a session that isn't a worker.
pub fn row(dir: &Path, state: &str, f: &Fold) -> Value {
    let Some(l) = read_json::<Link>(&dir.join("worker.json")) else {
        return Value::Null;
    };
    // Held, waiting for its row's reset: its limit, though no turn hit one yet [D2028, D3029].
    let waits = f.hold.as_ref().filter(|h| h["phase"] == "waiting");
    let (state, resets) = match waits {
        Some(h) => ("limited", h["resets"].as_u64()),
        None => (state, f.resets),
    };
    let last = &l.last;
    let (kind, word) = match state {
        "waiting_answer" | "sign_in" => ("needsYou", "Needs you".to_string()),
        "limited" | "out_of_credits" => (
            "limit",
            match resets {
                Some(at) => format!("Limit until {}", clock(at)),
                None => "Limit".into(),
            },
        ),
        _ if l.paused => ("paused", "Paused".into()),
        "logged" | "starting" | "working" | "silent" | "retrying" | "checking" | "uncertain"
        | "stalled" | "asking" => ("working", "Working".into()),
        "reconnecting" => ("working", "Reconnecting…".into()),
        // Its last message never reached it, or its host doesn't answer: never an older turn's Done.
        "undelivered" => ("failed", "Couldn't send".into()),
        "unresponsive" => ("working", "Not responding".into()),
        "no_turn_started" => ("working", "Not started yet".into()),
        // A turn that ended with background jobs left has ended: its result says how [D324], once
        // it's written. Till then, or with a message on its way to it, it works on.
        "idle" | "idle_jobs" if reports(dir, &l, f) => ("working", "Working".into()),
        _ => match last["how"].as_str() {
            Some("failed") => ("failed", "Failed".into()),
            Some("context") => ("failed", "Context full".into()),
            Some("refused") => ("failed", "Refused by its provider".into()),
            Some("stopped") => ("stopped", "Stopped".into()),
            Some(_) if last["merged"] == true => match core::worktrees::base(dir) {
                Some(base) => ("merged", format!("Merged into {base}")),
                None => ("merged", "Merged".into()),
            },
            Some(_) if last["landed"] == false => ("doneNotMerged", "Done · not merged".into()),
            Some(_) => ("done", "Done".into()),
            None if state == "failed" || state == "interrupted" => ("failed", "Failed".into()),
            None if state == "new" => ("working", "Starting".into()),
            // A mockup worker between rounds waits on the user's pick once the round is all in, else
            // on their notes [D560]; once picked it builds, and a turn it ends then waits on its lead,
            // not the user.
            None if !l.asked["mockup"].is_null()
                && !read_json::<Value>(&dir.join("mockup.json"))
                    .is_some_and(|m| m["picked"].is_string()) =>
            {
                let m = read_json::<Value>(&dir.join("mockup.json")).unwrap_or_default();
                match crate::relay::mockup::all_in(&m) {
                    true => ("needsYou", "Ready · pick one with Use".into()),
                    false => ("needsYou", "Waiting for your notes".into()),
                }
            }
            // Its turn ended, its outcome not yet written: still finishing, never back to Starting.
            None => ("working", "Working".into()),
        },
    };
    let ran = &l.ran;
    // A retry's step is on its record in its parent's folder [D2037].
    let wid = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let retry = (dir.parent().and_then(Path::parent))
        .and_then(|data| super::record(data, &l.parent, wid))
        .map(|r| r.retry)
        .unwrap_or_default();
    // As the receipt draws it: "GPT-6.1-Sol · High" [D3018].
    let shown = ran["name"].as_str().or(ran["model"].as_str());
    let effort = ran["effort"].as_str().map(crate::routing::capital);
    let model: Vec<&str> = [shown, effort.as_deref()].into_iter().flatten().collect();
    json!({"parent": l.parent, "root": l.root, "depth": l.depth, "brief": l.brief, "started": l.at,
        "kind": kind, "word": word, "ended": last["at"], "model": model.join(" · "),
        "receipt": crate::routing::receipt(ran).unwrap_or_else(|| format!("Ran on {}", model.join(" · "))),
        "asked": crate::routing::asked(&l.asked, ran), "why": crate::routing::why(&l.asked, ran, &retry), "added": last["added"], "removed": last["removed"],
        // A folder chat's worker: the repos it claimed, for its row [D494].
        "repos": core::folder::claims(dir).into_iter().map(|(name, _)| name).collect::<Vec<_>>(),
        "now": if kind == "working" { f.calls.last() } else { None },
        // What its review did, or why it didn't run.
        "review": match l.review["state"].as_str() {
            Some("running" | "sending" | "sent") => json!("Being reviewed"),
            Some("glancing") => json!("Deciding whether it needs a review"),
            _ => l.review["line"].clone(),
        },
        // When its wait is over, for the daemon's pass.
        "due": waits.map(|h| h["resets"].as_u64().unwrap_or(0))})
}

/// `busy`, for the row in `dir`.
fn reports(dir: &Path, l: &Link, f: &Fold) -> bool {
    let wid = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
    (dir.parent().and_then(Path::parent))
        .is_some_and(|data| super::busy_in(data, wid, l, || Ok(f), true))
}

/// "15:10", or a day or more away "Mon 09:00", as the model picker says when a limit resets.
pub(crate) fn clock(ms: u64) -> String {
    let tm = brigadier_core::os::local_time((ms / 1000) as i64);
    let day = ["Sun ", "Mon ", "Tue ", "Wed ", "Thu ", "Fri ", "Sat "][tm.tm_wday as usize % 7];
    let far = ms >= brigadier_frames::log::now_ms() + 86_400_000;
    format!(
        "{}{:02}:{:02}",
        if far { day } else { "" },
        tm.tm_hour,
        tm.tm_min
    )
}

/// Whether session `id`'s answered turn is still held open by what it started (`Fold::holding`),
/// `child` saying its agent's process lives. A message sent then waits in the queue, a Steer and a
/// worker's result carry the block on [D521]. Workers the user paused keep the block open but make
/// no message wait, as the old app's: they may wait for that very message.
pub fn holds(data: &Path, id: &str, f: &Fold, child: bool) -> bool {
    let paused = |w: &str| super::link(data, w).is_some_and(|l| l.paused);
    f.holding(child, |w| paused(w) || super::over(data, id, w))
}

/// The same, read from its log and its host.
pub fn holding(data: &Path, id: &str) -> bool {
    core::fold(&core::session_dir(data, id), true)
        .is_ok_and(|f| holds(data, id, &f.fold, crate::child(data, id).is_some()))
}

/// A worker done but not merged is looked at again now and then, so once its parent merges it
/// with git, its row says Done [D3003].
pub(super) fn merged(data: &Path, wid: &str) {
    static CHECKED: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);
    {
        let mut checked = CHECKED.lock().unwrap();
        let at = checked.get_or_insert_with(HashMap::new).entry(wid.into());
        let at = at.or_insert_with(|| Instant::now() - Duration::from_secs(10));
        if at.elapsed() < Duration::from_secs(10) {
            return;
        }
        *at = Instant::now();
    }
    let dir = core::session_dir(data, wid);
    if core::worktrees::unlanded(&dir).is_ok_and(|b| b.is_none())
        && let Some(mut l) = link(data, wid)
    {
        l.last["landed"] = true.into();
        let _ = write_json(&dir.join("worker.json"), &l);
    }
}
