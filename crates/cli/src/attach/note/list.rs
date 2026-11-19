//! A notes folder's list, as the notes column shows it [D913]: pinned first, then the newest, each
//! with its first line under its name; with words typed, the notes holding every one of them
//! anywhere in their text, with the line around the first [D921].

use super::{check_id, moved, plain, split, title};
use crate::remove;
use brigadier_core as core;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// Proposed: how much of a matched line the list shows on each side of the match.
const AROUND: usize = 40;

/// The folder's pinned notes, one id a line in `.pins`.
fn pins(dir: &Path) -> Vec<String> {
    (fs::read_to_string(dir.join(".pins"))
        .unwrap_or_default()
        .lines())
    .filter(|id| check_id(id).is_ok())
    .map(String::from)
    .collect()
}

/// Pins or unpins a note.
pub(super) fn pin(dir: &Path, note: &str, on: bool) -> io::Result<Value> {
    let mut all = pins(dir);
    all.retain(|id| id != note);
    if on {
        all.push(note.into());
    }
    match all.is_empty() {
        true => remove(&dir.join(".pins"))?,
        false => core::write_atomic(&dir.join(".pins"), all.join("\n").as_bytes())?,
    }
    Ok(json!({"ok": true}))
}

/// The line under a note's name: its first line of text after the one that names it.
fn preview<'a>(text: &'a str, name: &str) -> &'a str {
    let (head, body) = split(text);
    let mut lines = body.lines().map(plain).filter(|l| !l.is_empty());
    let first = lines.next().unwrap_or("");
    // An unnamed note is named by its first line: the line after it shows.
    match super::named(head).is_empty() && first == name {
        true => lines.next().unwrap_or(""),
        false => first,
    }
}

/// The line around the first word's match, cut to a few words each side; None: a word is missing.
fn matched(text: &str, words: &[String]) -> Option<String> {
    let lower = text.to_lowercase();
    if !words.iter().all(|w| lower.contains(w.as_str())) {
        return None;
    }
    let first = words.first()?;
    let line = plain(
        text.lines()
            .find(|l| l.to_lowercase().contains(first.as_str()))?,
    );
    let chars: Vec<char> = line.chars().collect();
    // Counted in the lowercased line, never cut from `line` by its byte: lowercasing can add chars.
    let lower = line.to_lowercase();
    let at = lower[..lower.find(first.as_str()).unwrap_or(0)]
        .chars()
        .count()
        .min(chars.len());
    let (from, to) = (
        at.saturating_sub(AROUND),
        (at + first.chars().count() + AROUND).min(chars.len()),
    );
    let cut: String = chars[from..to].iter().collect();
    Some(format!(
        "{}{}{}",
        if from > 0 { "…" } else { "" },
        cut,
        if to < chars.len() { "…" } else { "" }
    ))
}

/// `list [--q <words>]`: the notes of `dir`, and those still waiting to move into it.
pub(super) fn run(data: &Path, dir: &Path, q: Option<&str>) -> Value {
    let words: Vec<String> = q
        .unwrap_or("")
        .to_lowercase()
        .split_whitespace()
        .map(String::from)
        .collect();
    let pinned = pins(dir);
    let paths = (fs::read_dir(dir).into_iter().flatten().flatten()).map(|e| e.path());
    let mut notes: Vec<(bool, u64, Value)> = vec![];
    for path in paths.chain(moved::waiting_into(data, dir)) {
        let Some(note) = note_of(&path) else { continue };
        let at = (fs::metadata(&path).and_then(|m| m.modified()).ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        let text = fs::read_to_string(&path).unwrap_or_default();
        let hit = match words.is_empty() {
            true => None,
            false => match matched(&text, &words) {
                Some(hit) => Some(hit),
                None => continue,
            },
        };
        let (name, pin) = (title(&text), pinned.contains(&note));
        let shown = preview(&text, name);
        // A match already in sight, in the name or the line under it, isn't shown again.
        let hit = hit.filter(|h| {
            !name
                .to_lowercase()
                .contains(&h.trim_matches('…').to_lowercase())
                && !shown.contains(h.trim_matches('…'))
        });
        let head = split(&text).0;
        notes.push((pin, at, json!({"id": note, "title": name, "head": head, "preview": shown, "at": at, "pinned": pin, "match": hit})));
    }
    notes.sort_by_key(|n| (!n.0, std::cmp::Reverse(n.1)));
    json!({"ok": true, "notes": notes.into_iter().map(|(.., n)| n).collect::<Vec<_>>()})
}

/// A note's id, from its file's path; None for anything else in the folder.
fn note_of(path: &Path) -> Option<String> {
    let note = path.file_stem()?.to_str()?;
    (path.extension().is_some_and(|e| e == "md") && check_id(note).is_ok()).then(|| note.into())
}
