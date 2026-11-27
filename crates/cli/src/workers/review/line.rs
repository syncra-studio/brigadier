//! A review's words: the counts its messages say, and the line its worker's result carries.

use serde_json::Value;

pub(super) use brigadier_core::fold::plan::count;

pub(super) fn cut(mut s: String, most: usize) -> String {
    if s.len() > most {
        let mut at = most;
        while !s.is_char_boundary(at) {
            at -= 1;
        }
        s.truncate(at);
        s += "\n[cut]";
    }
    s
}

/// How a turn ended, in the reviewer's or fix turn's words.
pub(super) fn word(how: &str) -> &'static str {
    match how {
        "stopped" => "was stopped",
        "limit" => "stopped at a usage limit",
        "refused" => "was refused by its provider",
        "context" => "ran out of context",
        _ => "failed",
    }
}

/// "Reviewed by ‹model› because it changes `package.json`: 4 findings, 3 fixed, 1 rejected", each
/// count only where it was said; the why only where rule A gave one [D46].
pub(super) fn reviewed(r: &Value, fixed: Option<u64>, rejected: Option<u64>) -> String {
    let mut r = r.clone();
    if let Some(why) = r["why"].as_str() {
        let model = r["model"].as_str().unwrap_or("another model");
        r["model"] = format!("{model} because {why}").into();
    }
    brigadier_core::fold::plan::reviewed("Reviewed by", &r, fixed, rejected)
}
