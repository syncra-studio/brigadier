//! A review's words: the counts its messages say, and the line its worker's result carries.

use serde_json::Value;

/// The number on the last line saying `key` ("findings: 4", any case); none when it isn't said
/// [D74].
pub(super) fn count(text: &str, key: &str) -> Option<u64> {
    let text = text.to_lowercase();
    let rest = text
        .lines()
        .rev()
        .find_map(|l| l.split_once(key).map(|(_, r)| r))?;
    let digits: String = rest
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

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
        "context" => "ran out of context",
        _ => "failed",
    }
}

/// "Reviewed by ‹model›: 4 findings, 3 fixed, 1 rejected", each count only where it was said.
pub(super) fn reviewed(r: &Value, fixed: Option<u64>, rejected: Option<u64>) -> String {
    let n = r["findings"].as_u64();
    let found = n.map(|n| match n {
        0 => "no findings".to_string(),
        1 => "1 finding".into(),
        n => format!("{n} findings"),
    });
    let parts: Vec<String> = [
        found,
        fixed.map(|n| format!("{n} fixed")),
        rejected.map(|n| format!("{n} rejected")),
    ]
    .into_iter()
    .flatten()
    .collect();
    let model = r["model"].as_str().unwrap_or("another model");
    match parts.is_empty() {
        true => format!("Reviewed by {model}"),
        false => format!("Reviewed by {model}: {}", parts.join(", ")),
    }
}
