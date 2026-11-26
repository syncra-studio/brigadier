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
