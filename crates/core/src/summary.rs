//! The summary turn [repo-merge D85, D92, D93; design rev 3 §2.2]: before a renewal, the old
//! conversation writes what the fresh one should know, as one more turn of Brigadier's own origin
//! `"summary"`, with no tools. Off unless `BRIGADIER_SUMMARY=1`, until the bench shows it adds no
//! made-up facts and loses no recall (D93).

use std::path::{Path, PathBuf};
use std::time::Duration;

/// A summary turn's most: past it, it's stopped and counts as failed (§4).
pub const LIMIT: Duration = Duration::from_secs(180);

/// Whether renewals write a summary first.
pub fn on() -> bool {
    std::env::var_os("BRIGADIER_SUMMARY").is_some_and(|v| v == "1")
}

/// The flag a summary turn holds while it runs: every tool call is refused under it.
pub fn flag(dir: &Path) -> PathBuf {
    dir.join("summarizing")
}

/// Whether a summary turn holds the session's tools now. A flag older than the turn's own limit,
/// and a little more, is one a crash left: it holds nothing.
pub fn running(dir: &Path) -> bool {
    let age = std::fs::metadata(flag(dir)).and_then(|m| m.modified());
    age.ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < LIMIT + Duration::from_secs(60))
}

/// The tool hook's answer [D92]: refused, with the reason, while the summary turn runs.
pub fn tool_hook(dir: Option<&Path>) -> Option<&'static str> {
    dir.filter(|d| running(d)).map(|_| {
        "Brigadier: this turn writes the conversation's summary, with no tools. Answer in text only."
    })
}

/// The summary input's words. shortcut: a placeholder until rev 3 §2.3's prompt lands (step 7).
// No word of it is one of the fake's directives, so the drills' summary turn runs no step.
pub const PROMPT: &str = "Brigadier renews this conversation next. First sum it up for the fresh one, as text only with no tools: what the user wants now, the rules and decisions that hold, what's done with its proof, what's open, and the next step.";

/// Whether `backend`'s CLI is proved to refuse every tool call before it runs, under the flag
/// [D92]. The others renew without a summary. shortcut: names only, the fake's, until step 8
/// wires Claude's PreToolUse hook; an adapter method once a second agent passes.
pub fn vetoes(backend: &str) -> bool {
    backend == "fake"
}

/// Whether this session's renewals write a summary first.
pub fn applies(spec: &crate::Spec, f: &crate::fold::Fold) -> bool {
    on() && vetoes(crate::rebirth::backend(spec, f))
}

/// Whether the old conversation can still write one after `last`: not at a usage limit, a sign-in
/// or a refused resume, nor past a window that refused it or the loop guard's stop; those renew
/// with the last summary carried [rev 3 §2.2].
pub fn runs(f: &crate::fold::Fold, last: &serde_json::Value) -> bool {
    let blocked = f.limit.is_some() || f.sign_in.is_some() || f.refused.is_some();
    let window = last["outcome"] == "failed" && last["why"] == "context";
    !blocked && !window && last["reason"] != "stall"
}

/// The turn the held renewal serves, as the fold had it when the summary input came: its cause,
/// its guard count. None with no renewal held.
pub fn served(f: &crate::fold::Fold) -> Option<serde_json::Value> {
    let r = f.renewing.as_ref()?;
    Some(r["last"].clone()).filter(|l| !l.is_null())
}
