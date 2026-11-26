//! The agent's kept lines, `brigadier keep` [D87; rev 2 §4.3]: goal changes and decisions it keeps
//! whole for good. Each op is a `kept` NOTE in the log; the list is their replay, a fork's inherited
//! ones first, so a line keeps its id through forks and drops with the turns a rewind takes.

use crate::handoff::estimate::tokens;
use serde_json::Value;
use std::path::Path;

/// The most a line, and the whole list, may hold, in estimated tokens; and its lines.
pub const LINE: usize = 100;
pub const ALL: usize = 650;
pub const LINES: usize = 20;

/// One kept line: its immutable id and its words.
pub struct Line {
    pub id: String,
    pub text: String,
}

fn apply(list: &mut Vec<Line>, item: &Value) {
    if item["kind"] != "note" || item["event"] != "kept" {
        return;
    }
    let (id, text) = (
        item["id"].as_str().unwrap_or(""),
        item["text"].as_str().unwrap_or(""),
    );
    match item["op"].as_str() {
        Some("add") => list.push(Line {
            id: id.into(),
            text: text.into(),
        }),
        Some("replace") => {
            if let Some(l) = list.iter_mut().find(|l| l.id == id) {
                l.text = text.into();
            }
        }
        Some("drop") => list.retain(|l| l.id != id),
        _ => {}
    }
}

/// The list as it stands: the inherited copy's ops first, then what still stands of the log.
pub fn list(dir: &Path) -> Vec<Line> {
    let mut list = vec![];
    let inherited = std::fs::read_to_string(dir.join("inherited.jsonl")).unwrap_or_default();
    for l in inherited.lines() {
        if let Ok(item) = serde_json::from_str::<Value>(l) {
            apply(&mut list, &item);
        }
    }
    let _ = crate::rewind::read_active(dir, |item| apply(&mut list, item));
    list
}

/// The list as the hand-off shows it, a line each.
pub fn shown(dir: &Path) -> String {
    (list(dir).iter())
        .map(|l| format!("- {}\n", l.text.trim()))
        .collect()
}

/// Why `text` can't go in as a new line, or in place of line `replacing`: past a limit.
pub fn refused(list: &[Line], replacing: Option<&str>, text: &str) -> Option<String> {
    if text.trim().is_empty() {
        return Some("a kept line can't be empty".into());
    }
    let n = tokens(text);
    if n > LINE {
        return Some(format!(
            "a kept line holds at most {LINE} estimated tokens; this one is {n}: shorten it"
        ));
    }
    let others = list.iter().filter(|l| Some(l.id.as_str()) != replacing);
    let (count, sum) = others.fold((1, n), |(c, s), l| (c + 1, s + tokens(&l.text)));
    (count > LINES || sum > ALL).then(|| {
        format!("the kept list is full ({LINES} lines, {ALL} estimated tokens in all): drop or shorten a line first")
    })
}
