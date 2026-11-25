//! The fake writer's replies to Send feedback's two prompts (core's `feedback`), so the flow runs on
//! Fake: each sentence of the note becomes a report (an idea when it asks for something, else a
//! bug), one that says "again" names the first issue listed, and the duplicate check calls every
//! report it is shown the same as its issues.

use serde_json::{Value, json};

const WRITE: &str = "You turn a note a user wrote about Brigadier";
const JUDGE: &str = "You decide whether new reports about Brigadier";
/// The queue's judge (cli's `queue/judge`): a message that says "fits" does, one that says "late"
/// answers only after the judge's patience has run out.
const FITS: &str = "An agent is in the middle of one piece of work.";

/// Whether `text` is one of Send feedback's prompts, or the queue judge's.
pub fn asked(text: &str) -> bool {
    text.starts_with(WRITE) || text.starts_with(JUDGE) || text.starts_with(FITS)
}

pub fn reply(text: &str) -> String {
    if text.starts_with(FITS) {
        let said = text.split_once("New message from the user:\n");
        let words = said.map_or("", |(_, w)| {
            w.split("\n\nDecide whether").next().unwrap_or("")
        });
        if words.contains("late") {
            std::thread::sleep(std::time::Duration::from_secs(8));
        }
        return if words.contains("fits") {
            "FITS"
        } else {
            "WAITS"
        }
        .into();
    }
    match text.starts_with(WRITE) {
        true => reports(text),
        false => matches(text),
    }
}

fn reports(text: &str) -> String {
    let note = (text.split_once("<<<\n"))
        .and_then(|(_, rest)| rest.split_once("\n>>>"))
        .map_or("", |(note, _)| note);
    let first =
        (text.lines()).find_map(|l| l.strip_prefix('#')?.split_once(' ')?.0.parse::<u64>().ok());
    let reports: Vec<Value> = (note.split(['.', '?', '!', '\n']))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            let lower = s.to_lowercase();
            let idea = ["could", "would like", "i'd like", "let me"]
                .iter()
                .any(|w| lower.contains(w));
            let title: String = s.chars().take(70).collect();
            let candidates: Vec<u64> = first
                .filter(|_| lower.contains("again"))
                .into_iter()
                .collect();
            match idea {
                true => json!({"kind": "idea", "title": title, "problem": s, "today": "Not given.",
                    "wanted": s, "candidates": candidates}),
                false => json!({"kind": "bug", "title": title, "area": "Other",
                    "steps": "Not given; see What happened.", "expected": "Not given.", "actual": s,
                    "candidates": candidates}),
            }
        })
        .collect();
    json!({"reports": reports}).to_string()
}

fn matches(text: &str) -> String {
    let (mut report, mut kind, mut found) = (0, "bug", vec![]);
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("Report ") {
            let (n, rest) = rest.split_once(' ').unwrap_or((rest, ""));
            report = n.parse().unwrap_or(0);
            kind = if rest.starts_with("(idea)") {
                "idea"
            } else {
                "bug"
            };
        }
        let number = (line.strip_prefix("--- issue #"))
            .and_then(|rest| rest.split_once(' ')?.0.parse::<u64>().ok());
        if let Some(issue) = number {
            found.push(json!({"report": report, "issue": issue, "issueKind": kind, "same": true}));
        }
    }
    json!({"matches": found}).to_string()
}
