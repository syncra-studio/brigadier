//! The archive [D88, D103]: what a session's conversations said, from its own log and a fork's
//! inherited copy, each entry under a reference that never shifts: its log frame's number, or
//! `i<line>` of the inherited copy, which is written once.

use serde_json::Value;
use std::io;
use std::path::Path;

/// Most of a tool's input or a failure's output kept in an entry; the log keeps all of it.
const CAP: usize = 1000;

pub struct Entry {
    /// `123` (its log frame) or `i45` (its inherited copy's line).
    pub at: String,
    /// user, agent, worker, peer, tool or error.
    pub from: &'static str,
    /// The worker, the session or the tool it names.
    pub who: String,
    pub text: String,
    pub files: Vec<String>,
    pub ts: u64,
}

fn capped(s: &str) -> String {
    match s.char_indices().nth(CAP) {
        Some((at, _)) => format!("{}…", &s[..at]),
        None => s.to_string(),
    }
}

fn paths(changes: &Value) -> Vec<String> {
    (changes.as_array().into_iter().flatten())
        .filter_map(|c| c["path"].as_str().map(String::from))
        .collect()
}

/// An item's entry, if it says anything worth finding: the user's words, a worker's result,
/// another session's message, the agent's text, a tool call and the files it changed, a failure.
pub fn entry(item: &Value, at: String) -> Option<Entry> {
    let s = |k: &str| item[k].as_str().unwrap_or("");
    let (from, who, text, files): (&str, String, String, Vec<String>) = match s("kind") {
        // A control (a Stop, a model change) is no message; Brigadier's own (a hand-off) isn't the user's.
        "input" if item["control"].is_object() => return None,
        "input" => match s("origin").split(':').collect::<Vec<_>>()[..] {
            ["user"] => ("user", String::new(), s("text").into(), vec![]),
            // A merge suffix may follow: result:finished:<id>:merged=main.
            ["result", _, worker, ..] => ("worker", worker.into(), s("text").into(), vec![]),
            ["peer", from] => ("peer", from.into(), s("text").into(), vec![]),
            _ => return None,
        },
        "text" => ("agent", String::new(), s("text").into(), vec![]),
        "tool" => (
            "tool",
            s("name").into(),
            capped(s("input")),
            paths(&item["changes"]),
        ),
        "tool_done" if item["ok"] == false => (
            "error",
            String::new(),
            capped(s("output")),
            paths(&item["changes"]),
        ),
        "tool_done" if item["changes"].as_array().is_some_and(|c| !c.is_empty()) => (
            "tool",
            String::new(),
            String::new(),
            paths(&item["changes"]),
        ),
        "failed" => ("error", String::new(), s("message").into(), vec![]),
        _ => return None,
    };
    if text.trim().is_empty() && files.is_empty() {
        return None;
    }
    Some(Entry {
        at,
        from,
        who,
        text,
        files,
        ts: item["ts"].as_u64().unwrap_or(0),
    })
}

/// An own log item's reference: its frame.
pub fn at(item: &Value) -> String {
    item["f"].as_u64().unwrap_or(0).to_string()
}

/// A fork's inherited copy as entries, by line; none for any other session.
pub fn inherited(dir: &Path) -> Vec<Entry> {
    let text = std::fs::read_to_string(dir.join("inherited.jsonl")).unwrap_or_default();
    (text.lines().enumerate())
        .filter_map(|(n, l)| entry(&serde_json::from_str(l).ok()?, format!("i{n}")))
        .collect()
}

/// The whole archive, oldest first: the inherited copy, then what still stands of its own log.
pub fn read(dir: &Path) -> io::Result<Vec<Entry>> {
    let mut all = inherited(dir);
    crate::rewind::read_active(dir, |item| all.extend(entry(item, at(item))))?;
    Ok(all)
}
