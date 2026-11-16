//! The sidebar's PR chip from the session's kept PRs (`prs.json`) [D1011, D1018].

use super::prs::kept;
use crate::git;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::AtomicBool;

/// The session's Merged chip shows but its branch has moved on (a new local commit): its next read
/// is due now, so the chip clears without waiting for the host's pace [D1018].
pub fn moved_on(data: &Path, id: &str) -> bool {
    let dir = crate::session_dir(data, id);
    let kept = kept(&dir);
    if chip(&dir, &kept)["chip"] != "merged" {
        return false;
    }
    let Ok(folder) = git::folder(data, &git::Target::Session(id)) else {
        return false;
    };
    git::read(&folder, &["rev-parse", "HEAD"], &AtomicBool::new(false))
        .is_ok_and(|out| kept["head"] != String::from_utf8_lossy(&out).trim())
}

/// The merged PRs the user has seen (`pr-seen`, numbers): opening the session sees them all.
fn seen_merged(dir: &Path) -> Vec<u64> {
    let text = fs::read_to_string(dir.join("pr-seen")).unwrap_or_default();
    text.split_whitespace()
        .filter_map(|n| n.parse().ok())
        .collect()
}

/// The session was opened: its merged PRs are seen, so their Merged chip clears [D1018].
pub fn opened(dir: &Path) -> io::Result<()> {
    let kept = kept(dir);
    let merged: Vec<u64> = (kept["prs"].as_array().into_iter().flatten())
        .filter(|p| p["state"] == "merged")
        .filter_map(|p| p["number"].as_u64())
        .collect();
    let seen = seen_merged(dir);
    if merged.iter().all(|n| seen.contains(n)) {
        return Ok(());
    }
    let all: Vec<String> = (seen.iter().chain(&merged)).map(u64::to_string).collect();
    crate::write_atomic(&dir.join("pr-seen"), all.join(" ").as_bytes())
}

/// The sidebar's PR chip from every PR the session keeps [D1011, D1018, D1231] (the words are
/// proposed): the one that needs you most, Checks failed over Conflict (with its base, from the
/// host) over Changes asked over Ready; else Merged, while the merge isn't seen and the branch
/// still ends at the merged head. Null when no PR needs a word.
pub fn chip(dir: &Path, kept: &Value) -> Value {
    let rows: Vec<&Value> = kept["prs"].as_array().into_iter().flatten().collect();
    let mark = |p: &Value| match (p["state"].as_str(), p["health"].as_str()) {
        (Some("merged"), _) => "merged",
        (Some("closed"), _) => "closed",
        (_, Some("failed")) => "checks_failed",
        (_, Some("conflicts")) => "conflict",
        (_, Some("changes")) => "changes_asked",
        (_, Some("running")) => "running",
        // Ready to merge: not a draft, not waiting on a review, and the host says it merges [D1018].
        (_, Some("ready")) if p["draft"] == true => "draft",
        (_, Some("ready")) if p["approved"] == false || p["mergeable"] != true => "open",
        (_, Some("ready")) => "ready",
        _ => "open",
    };
    let seen = || seen_merged(dir);
    let unseen = |p: &&Value| {
        mark(p) == "merged"
            && p["head"] == kept["head"]
            && p["number"].as_u64().is_some_and(|n| !seen().contains(&n))
    };
    let chip = (["checks_failed", "conflict", "changes_asked", "ready"].into_iter())
        .find(|chip| rows.iter().any(|p| mark(p) == *chip))
        .or_else(|| rows.iter().any(unseen).then_some("merged"));
    chip.map_or(Value::Null, |chip| {
        // The PR the chip is about goes first: a click opens the first whose mark is the chip's.
        let first = (rows.iter()).position(|p| match chip {
            "merged" => unseen(p),
            _ => mark(p) == chip,
        });
        let mut rows = rows.clone();
        if let Some(i) = first {
            let p = rows.remove(i);
            rows.insert(0, p);
        }
        let prs: Vec<Value> = (rows.iter())
            .map(|p| json!({"number": p["number"], "mark": mark(p)}))
            .collect();
        json!({"chip": chip, "prs": prs})
    })
}
