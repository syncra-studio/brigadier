//! Brigadier's own checks on a turn's end, outside the prompt [D527, D529]: a question asked in
//! the reply's words instead of the question tool gets one send-back [D484], and each session
//! keeps local counts of its misses in `rules.json`, never sent anywhere [D530].

use serde_json::{Value, json};
use std::path::Path;

/// The one send-back, a fact rather than an order, as hooks' added context should be.
pub const SEND_BACK: &str = "[Brigadier: your reply ends by asking the user in prose. Brigadier shows questions only through your question tool, so ask there.]";

/// Words that ask the user for a choice, a fact or a go-ahead the next step waits on. A sign-off
/// about later events ("let me know if anything breaks") is none of them.
const ASKS: [&str; 14] = [
    "tell me which",
    "tell me whether",
    "let me know which",
    "let me know whether",
    "let me know if i should",
    "let me know if you want me",
    "let me know if you'd like me",
    "your call",
    "say go",
    "say yes",
    "say the word",
    "want me to",
    "shall i",
    "should i",
];

/// Whether a reply ends by asking the user in prose: its last paragraph outside fences, quotes
/// and code ends on a question, asks in so many words, or is a list of items that open with one.
pub fn asks_in_prose(reply: &str) -> bool {
    let paragraphs = prose(reply);
    let Some(last) = paragraphs.last() else {
        return false;
    };
    let list = last.iter().all(|l| item(l).is_some());
    let lead = (paragraphs.len() > 1 && list).then(|| &paragraphs[paragraphs.len() - 2]);
    let said: Vec<String> = lead
        .into_iter()
        .chain([last])
        .flatten()
        .flat_map(|l| sentences(item(l).unwrap_or(l)))
        .collect();
    let ends = |s: &str| s.ends_with('?');
    // A quoted question isn't one: its closing quote comes after the mark.
    let opens = |l: &String| {
        sentences(item(l).unwrap_or(l))
            .first()
            .is_some_and(|s| ends(s) && !s.contains([':', '"', '“']))
    };
    said.last().is_some_and(|s| ends(s))
        || (list
            && (lead.is_some_and(|p| {
                p.last()
                    .is_some_and(|l| sentences(l).last().is_some_and(|s| ends(s)))
            }) || last.iter().any(opens)))
        || said.iter().any(|s| {
            // Whole words only: "your callback" isn't "your call".
            let words: String = (s.to_lowercase().replace('’', "'").chars())
                .map(|c| {
                    if c.is_alphanumeric() || c == '\'' {
                        c
                    } else {
                        ' '
                    }
                })
                .collect();
            let s = format!(
                " {} ",
                words.split_whitespace().collect::<Vec<_>>().join(" ")
            );
            ASKS.iter().any(|a| s.contains(&format!(" {a} ")))
                || (["approve", "confirm", "pick", "choose"]
                    .iter()
                    .any(|v| s.starts_with(&format!(" {v} ")))
                    && (s.contains(" i'll ") || s.contains(" i will ")))
        })
}

/// The reply's prose paragraphs, each its lines: fenced blocks and `>` quotes are cut, inline code
/// dropped.
fn prose(reply: &str) -> Vec<Vec<String>> {
    let (mut out, mut para, mut fenced) = (vec![], vec![], false);
    for line in reply.lines() {
        let t = line.trim();
        if t.starts_with("```") || t.starts_with("~~~") {
            fenced = !fenced;
        }
        if fenced
            || t.is_empty()
            || t.starts_with("```")
            || t.starts_with("~~~")
            || t.starts_with('>')
        {
            if !para.is_empty() {
                out.push(std::mem::take(&mut para));
            }
            continue;
        }
        let plain: String = t.split('`').step_by(2).collect();
        para.push(plain.replace(['*', '_'], "").trim().to_string());
    }
    if !para.is_empty() {
        out.push(para);
    }
    out
}

/// A list item's text, past its marker.
fn item(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("- ").or_else(|| line.strip_prefix("• "));
    rest.or_else(|| {
        let digits = line
            .find(|c: char| !c.is_ascii_digit())
            .filter(|&n| n > 0)?;
        line[digits..]
            .strip_prefix(". ")
            .or_else(|| line[digits..].strip_prefix(") "))
    })
}

/// A line's sentences, each with its closing mark.
fn sentences(line: &str) -> Vec<String> {
    let (mut out, mut s) = (vec![], String::new());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        s.push(c);
        if matches!(c, '.' | '!' | '?') && chars.peek().is_none_or(|n| n.is_whitespace()) {
            out.push(s.trim().to_string());
            s.clear();
        }
    }
    if !s.trim().is_empty() {
        out.push(s.trim().to_string());
    }
    out
}

/// Counts a judged turn end in the session's `rules.json`: `hit` its reply asked in prose, `sent`
/// it went back for that, `retry` it was the answer to a send-back. A final reply adds its prose
/// lines and drafts left in fences. `by`: the turn's id, or the agent whose own hook judged it.
pub fn count(dir: &Path, reply: &str, hit: bool, sent: bool, retry: bool, by: Value) {
    let path = dir.join("rules.json");
    let mut c: Value = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({}));
    let mut add = |k: &str, n: usize| c[k] = (c[k].as_u64().unwrap_or(0) + n as u64).into();
    add("asked_in_prose", (hit && !retry) as usize);
    add("sent_back", sent as usize);
    add("still_in_prose", (hit && retry) as usize);
    if !sent {
        let fences = reply
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with("```") && l.len() > 3);
        add(
            "fence_drafts",
            fences
                .filter(|l| l[3..].starts_with("text") || l[3..].starts_with("brigadier-message"))
                .filter(|l| *l != crate::norm::DRAFT.trim_end())
                .count(),
        );
        add("replies", 1);
        add("reply_lines", prose(reply).iter().map(Vec::len).sum());
    }
    c["judged"] = by;
    let _ = std::fs::write(&path, c.to_string());
}

/// Claude's `Stop` hook, as `brigadier hook stop <agent>`: judges the reply it is about to end
/// on, counts it, and sends it back once. Its record names the agent, so the daemon leaves that
/// agent's turns to it.
pub fn stop_hook(input: &Value, agent: &str, dir: Option<&Path>) -> Option<Value> {
    let reply = input["last_assistant_message"].as_str().unwrap_or("");
    let retry = input["stop_hook_active"] == true;
    let hit = asks_in_prose(reply);
    let sent = hit && !retry;
    if let Some(dir) = dir {
        count(dir, reply, hit, sent, retry, json!({"hook": agent}));
    }
    sent.then(|| json!({"decision": "block", "reason": SEND_BACK}))
}
