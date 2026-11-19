//! Find in the conversation, for the rows the view hasn't loaded [D470]: the old app's engine
//! search [D48], over the same words the view's own find reads (`thread/find-text.ts`).

use super::Thread;
use serde_json::{Value, json};

/// A list item's, quote's or heading's mark at a line's start (after up to 3 spaces), with the space after it.
fn mark_len(line: &str) -> usize {
    let lead = line.len() - line.trim_start().len();
    if lead > 3 {
        return 0;
    }
    let rest = &line[lead..];
    let spaced = |n: usize| {
        let gap = rest[n..].len() - rest[n..].trim_start().len();
        if gap > 0 { lead + n + gap } else { 0 }
    };
    let hashes = rest.bytes().take_while(|&b| b == b'#').count();
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    match rest.as_bytes().first() {
        Some(b'#') if hashes <= 6 => spaced(hashes),
        Some(b'>') => lead + 1 + usize::from(rest[1..].starts_with(char::is_whitespace)),
        Some(b'-' | b'*' | b'+') => spaced(1),
        Some(b'0'..=b'9') if matches!(rest.as_bytes().get(digits), Some(b'.' | b')')) => {
            spaced(digits + 1)
        }
        _ => 0,
    }
}

/// Prose without links' targets and emphasis marks: `[a](b)` shows `a`.
fn prose(text: &str, out: &mut String) {
    let mut at = 0;
    while at < text.len() {
        let rest = &text[at..];
        let link = rest.strip_prefix('!').unwrap_or(rest);
        if let Some(inner) = link.strip_prefix('[')
            && let Some(close) = inner.find(']')
            && let Some(target) = inner[close + 1..].strip_prefix('(')
            && let Some(end) = target.find(')')
        {
            prose(&inner[..close], out);
            at += rest.len() - target.len() + end + 1;
        } else if ["**", "__", "~~"].iter().any(|m| rest.starts_with(m)) {
            at += 2;
        } else if rest.starts_with('`') {
            at += 1;
        } else {
            let c = rest.chars().next().unwrap();
            out.push(c);
            at += c.len_utf8();
        }
    }
}

/// Markdown's marks an answer drawn shows without, as the UI's `unmarked` (find-text.ts): fences, headings, quotes,
/// list marks, links' targets, emphasis. Code, fenced or inline, keeps what it says.
fn unmarked(text: &str) -> String {
    let mut fenced = false;
    let mut out = String::new();
    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            out.push('\n');
        }
        let lead = line.len() - line.trim_start().len();
        if lead <= 3 && line[lead..].starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            out.push_str(line);
            continue;
        }
        let rest = &line[mark_len(line)..];
        // Prose and inline code by turns: a run of backticks to the next run as long.
        let mut from = 0;
        let mut at = 0;
        while let Some(start) = rest[at..].find('`').map(|i| at + i) {
            let ticks = rest[start..].bytes().take_while(|&b| b == b'`').count();
            let body = start + ticks;
            // Bytes, not str slices: `i` walks every byte, inside multibyte characters too.
            let bytes = rest.as_bytes();
            let close = (body..rest.len()).find(|&i| {
                bytes[i..].iter().take_while(|&&b| b == b'`').count() == ticks
                    && i > body
                    && bytes[i - 1] != b'`'
            });
            match close {
                Some(end) => {
                    prose(&rest[from..start], &mut out);
                    out.push_str(&rest[body..end]);
                    from = end + ticks;
                    at = from;
                }
                None => at = body,
            }
        }
        prose(&rest[from..], &mut out);
    }
    out
}

/// What a row says, as find reads it while not drawn: the words it shows, not every label.
fn words(item: &Value) -> Vec<std::borrow::Cow<'_, str>> {
    let text = |key: &str| item[key].as_str();
    let fields: Vec<Option<&str>> = match item["kind"].as_str() {
        Some("message") if item["role"] == "assistant" => {
            return text("text")
                .map(|t| vec![unmarked(t).into()])
                .unwrap_or_default();
        }
        Some("message") | Some("notice") => vec![text("text")],
        Some("reasoning") => vec![text("heading"), text("text")],
        // Another tool's row shows only its name.
        Some("tool") if matches!(text("step"), None | Some("other")) => vec![text("name")],
        Some("tool") => vec![text("name"), text("input")],
        Some("question") => vec![text("question"), text("answer")],
        Some("childAgent") => vec![text("title"), text("answer")],
        Some("fileChange") => item["changes"]
            .as_array()
            .map_or(vec![], |c| c.iter().map(|c| c["path"].as_str()).collect()),
        _ => vec![],
    };
    fields.into_iter().flatten().map(Into::into).collect()
}

impl Thread {
    /// Where `query` is, case aside, in the rows older than row `before` (an `n`): each row's `n`
    /// and how many times, oldest first, counted from the newest up to `limit` in all; `more` when
    /// it stopped there. The view asks for every row's, and counts those it holds itself.
    pub fn find(&self, before: u64, query: &str, limit: usize) -> Value {
        let needle = query.to_lowercase();
        let (mut matches, mut more, mut left) = (vec![], false, limit);
        let end = before.saturating_sub(1).min(self.items.len() as u64) as usize;
        if !needle.is_empty() {
            self.items.read_all();
        }
        for item in self.items.range(0..end).rev() {
            let Some(n) = item["n"].as_u64() else {
                continue;
            };
            if needle.is_empty() || item["hidden"] == true {
                continue;
            }
            let count: usize = words(item)
                .iter()
                .map(|w| w.to_lowercase().matches(&needle).count())
                .sum();
            let take = count.min(left);
            if take > 0 {
                matches.push(json!({"n": n, "count": take}));
                left -= take;
            }
            if count > take {
                more = true;
                break;
            }
        }
        matches.reverse();
        json!({"matches": matches, "more": more})
    }
}
