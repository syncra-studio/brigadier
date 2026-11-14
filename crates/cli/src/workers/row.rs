//! A worker's row facts [D3010, D3012, D3018].

use super::{Link, read_json};
use brigadier_core::{self as core};
use serde_json::{Value, json};
use std::path::Path;

/// A worker's row facts, for its row [D3010, D3012, D3018]: its parent and brief, its state in
/// a word as the old `workerState`, and its receipt. Null for a session that isn't a worker.
pub fn row(dir: &Path, state: &str, resets: Option<u64>, now: Option<&Value>) -> Value {
    let Some(l) = read_json::<Link>(&dir.join("worker.json")) else {
        return Value::Null;
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
        // A turn that ended with background jobs left has ended: its result says how [D324].
        "logged" | "starting" | "working" | "silent" | "retrying" | "checking" | "uncertain"
        | "stalled" | "asking" => ("working", "Working".into()),
        _ => match last["how"].as_str() {
            Some("failed") => ("failed", "Failed".into()),
            Some("context") => ("failed", "Context full".into()),
            Some("stopped") => ("stopped", "Stopped".into()),
            Some(_) if last["merged"] == true => match core::worktrees::base(dir) {
                Some(base) => ("merged", format!("Merged into {base}")),
                None => ("merged", "Merged".into()),
            },
            Some(_) if last["landed"] == false => ("doneNotMerged", "Done · not merged".into()),
            Some(_) => ("done", "Done".into()),
            None if state == "failed" || state == "interrupted" => ("failed", "Failed".into()),
            None if state == "new" => ("working", "Starting".into()),
            // Its turn ended, its outcome not yet written: still finishing, never back to Starting.
            None => ("working", "Working".into()),
        },
    };
    let ran = &l.ran;
    let model = [&ran["agent"], &ran["model"], &ran["effort"]];
    let model: Vec<&str> = model.iter().filter_map(|v| v.as_str()).collect();
    json!({"parent": l.parent, "root": l.root, "depth": l.depth, "brief": l.brief, "started": l.at,
        "kind": kind, "word": word, "ended": last["at"], "model": model.join(" · "),
        "receipt": crate::routing::receipt(ran).unwrap_or_else(|| format!("Ran on {}", model.join(" · "))), "added": last["added"], "removed": last["removed"],
        "now": if kind == "working" { now } else { None }})
}

pub(crate) fn clock(ms: u64) -> String {
    let secs = (ms / 1000) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    format!("{:02}:{:02}", tm.tm_hour, tm.tm_min)
}
