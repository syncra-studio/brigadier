//! What was decided of each message, one line each in the session's folder (`decided.jsonl`), so a
//! wrong steer can be explained afterwards [D41].

use super::{Item, Verdict};
use brigadier_core as core;
use brigadier_frames::log::now_ms;
use serde_json::{Value, json};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

/// One line for `item`: what the judge made of it (none, it wasn't judged) and what became of it.
pub(super) fn keep(data: &Path, id: &str, item: &Item, verdict: Option<&Verdict>, then: &str) {
    let judged = verdict.map_or(Value::Null, |v| {
        json!({"verdict": if v.fits { "fits" } else { v.waits.unwrap_or("not asked") },
               "said": v.said, "model": v.model, "error": v.error, "work": v.work,
               "workers": v.working, "asked": v.asked, "ms": v.took.as_millis() as u64})
    });
    let line =
        json!({"id": item.id, "queued": item.at, "at": now_ms(), "judged": judged, "then": then});
    let path = core::session_dir(data, id).join("decided.jsonl");
    let kept = (OpenOptions::new().create(true).append(true).open(path))
        .and_then(|mut f| writeln!(f, "{line}"));
    // Nothing waits on it.
    if let Err(e) = kept {
        eprintln!("brigadierd: judge {id}: {e}");
    }
}
