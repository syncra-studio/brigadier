//! Where everything else is [repo-merge D85; §2.7]: every conversation of the session, the user's
//! every message, search, and any record whole, each one `brigadier` command away.

use super::Past;
use super::records::key;

/// The conversations listed one by one; older ones share a range line.
const CONVERSATIONS: usize = 20;

pub(super) fn section(id: &str, p: &Past) -> String {
    // Every record, the answers too: `past()` keeps them apart from the entries.
    let mut all: Vec<&str> = (p.entries.iter().map(|e| e.at.as_str()))
        .chain(p.answers.iter().map(|a| a.0.as_str()))
        .collect();
    all.sort_by_key(|at| key(at));
    let (Some(&first), Some(&end)) = (all.first(), all.last()) else {
        return String::new();
    };
    let read = |a: &str, b: &str| format!("`brigadier read {id}#{a} --to {b}`");
    let mut starts = p.starts.clone();
    if starts.first().is_none_or(|s| key(&s.0) > key(first)) {
        starts.insert(0, (first.into(), "the first".into()));
    }
    // Each conversation runs from its start to the last entry before the next one's.
    let last_before = |at: &str, next: Option<&(String, String)>| {
        let next = next.map(|n| key(&n.0));
        (all.iter().rev())
            .find(|e| next.is_none_or(|n| key(e) < n) && key(e) >= key(at))
            .map_or(at.to_string(), |e| e.to_string())
    };
    let lines: Vec<String> = (starts.iter().enumerate())
        .map(|(k, (at, how))| {
            let next = starts.get(k + 1);
            let just = if next.is_none() {
                ", the one that just ended"
            } else {
                ""
            };
            let to = last_before(at, next);
            format!("- conversation {}{just}, {how}: {}\n", k + 1, read(at, &to))
        })
        .collect();
    let older = lines.len().saturating_sub(CONVERSATIONS);
    let mut out = String::from("\n## Where everything else is\n");
    if older > 0 {
        let to = last_before(first, starts.get(older));
        out += &format!("- conversations 1–{older}: {}\n", read(first, &to));
    }
    out += &lines[older..].concat();
    // The user's answers to questions are theirs too, as `--user` reads them.
    let mut user: Vec<&str> = (p.entries.iter().filter(|e| e.from == "user"))
        .map(|e| e.at.as_str())
        .chain((p.answers.iter().filter(|a| a.2.is_empty())).map(|a| a.0.as_str()))
        .collect();
    user.sort_by_key(|at| key(at));
    if let (Some(a), Some(b)) = (user.first(), user.last()) {
        out += &format!(
            "- every message of the user's, whole: `brigadier read {id}#{a} --to {b} --user`\n"
        );
    }
    out += &format!(
        "- everything from {id}#{first} to {id}#{end}: `brigadier search \"<words>\" --in {id}` finds it\n- any record whole, a step's input or output uncut: `brigadier read {id}#<n> --raw` writes it to a file\n"
    );
    out
}
