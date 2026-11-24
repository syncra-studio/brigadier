//! A note's name, as its tab, its chip and the lists show it [D913].

use super::{images, split};
use brigadier_core as core;
use serde_json::Value;

/// Proposed: how much of a name the user gave a note is shown.
const SHOWN_CHARS: usize = 60;

/// A note's name as its tab, lists and chip show it: the one it was renamed to, cut, else the first
/// words of its first line, after the emoji that may lead them, by the rule a session's title has.
pub(super) fn short(text: &str) -> String {
    match named(split(text).0) {
        "" => {
            let line = title(text);
            core::title::from(
                Some(named(&line))
                    .filter(|w| !w.is_empty())
                    .unwrap_or(&line),
            )
        }
        name => core::title::one_line(name, SHOWN_CHARS),
    }
}

/// A note's whole name: the one it was renamed to, else its first line of text, without a
/// heading's #s [D913], else its first image's.
pub(super) fn title(text: &str) -> String {
    let (head, body) = split(text);
    match named(head) {
        "" => (images::words(body, false).lines().map(plain))
            .find(|line| !line.is_empty())
            .map(String::from)
            .or_else(|| images::name(body))
            .unwrap_or_default(),
        name => name.into(),
    }
}

/// A line as words, its Markdown marks off: a heading's #s, a list's or checklist's, a quote's, a
/// whole code fence's. A list's or quote's with nothing after it (an image was there) is empty.
pub(super) fn plain(line: &str) -> &str {
    let line = line.trim().trim_start_matches('#').trim_start();
    let item = line.trim_start_matches(|c: char| c.is_ascii_digit());
    if ["-", "*", "+", ">", ".", "- [ ]", "- [x]", "- [X]"].contains(&item) {
        return "";
    }
    let line = ["- [ ] ", "- [x] ", "- [X] ", "- ", "* ", "+ ", "> "]
        .iter()
        .find_map(|mark| line.strip_prefix(mark))
        .unwrap_or(line);
    let digits = line.trim_start_matches(|c: char| c.is_ascii_digit());
    let line = (digits.len() < line.len())
        .then(|| digits.strip_prefix(". "))
        .flatten()
        .unwrap_or(line)
        .trim();
    let fence = line.starts_with("~~~")
        || (line.strip_prefix("```")).is_some_and(|language| !language.contains('`'));
    if fence { "" } else { line }
}

/// The name in a note's `# ` line, without the emoji that may lead it, one before a space as the
/// page reads it; empty: it was never renamed.
pub(super) fn named(head: &str) -> &str {
    let head = head.trim();
    let first = head.split_whitespace().next().unwrap_or("");
    let emoji = first.starts_with(|c: char| !c.is_ascii() && !c.is_alphanumeric())
        && core::title::one_drawn(first);
    if emoji {
        head[first.len()..].trim()
    } else {
        head
    }
}

/// A note's emoji and name, as its chip and menu row show it.
pub(crate) fn shown_name(note: &Value) -> String {
    let (head, title) = (
        note["head"].as_str().unwrap_or(""),
        note["title"].as_str().unwrap_or(""),
    );
    let emoji = head[..head.len() - named(head).len()].trim();
    let title = if title.is_empty() {
        "Untitled note"
    } else {
        title
    };
    format!("{emoji} {title}").trim().to_string()
}
