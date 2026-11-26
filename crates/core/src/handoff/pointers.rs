//! Where everything else is [repo-merge D85; §2.7]: every conversation of the session, the user's
//! every message, search, and any record whole, each one `brigadier` command away.

use super::Past;
use super::records::key;

/// The conversations listed one by one; older ones share a range line.
const CONVERSATIONS: usize = 20;

pub(super) fn section(id: &str, p: &Past) -> String {
    let (Some(first), Some(end)) = (p.entries.first(), p.entries.last()) else {
        return String::new();
    };
    let read = |a: &str, b: &str| format!("`brigadier read {id}#{a} --to {b}`");
    let mut starts = p.starts.clone();
    if starts.first().is_none_or(|s| key(&s.0) > key(&first.at)) {
        starts.insert(0, (first.at.clone(), "the first".into()));
    }
    // Each conversation runs from its start to the last entry before the next one's.
    let last_before = |at: &str, next: Option<&(String, String)>| {
        let next = next.map(|n| key(&n.0));
        (p.entries.iter().rev())
            .find(|e| next.is_none_or(|n| key(&e.at) < n) && key(&e.at) >= key(at))
            .map_or(at.to_string(), |e| e.at.clone())
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
        let to = last_before(&first.at, starts.get(older));
        out += &format!("- conversations 1–{older}: {}\n", read(&first.at, &to));
    }
    out += &lines[older..].concat();
    let mut user = (p.entries.iter()).filter(|e| e.from == "user");
    if let Some(a) = user.next() {
        let b = user.next_back().unwrap_or(a);
        out += &format!(
            "- every message of the user's, whole: `brigadier read {id}#{} --to {} --user`\n",
            a.at, b.at
        );
    }
    out += &format!(
        "- everything from {id}#{} to {id}#{}: `brigadier search \"<words>\" --in {id}` finds it\n- any record whole, a step's input or output uncut: `brigadier read {id}#<n> --raw` writes it to a file\n",
        first.at, end.at
    );
    out
}
