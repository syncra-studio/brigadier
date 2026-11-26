//! The conversation, oldest first [repo-merge D86, D59; rev 2 §4.1]: every message of the user's,
//! worker's result, other session's message and answer, in log order, whole up to a size, each
//! with the start of the answer its turn gave and a reference to everything else that turn said.

use super::estimate::tokens;
use super::room::{Keep, Unit, WHOLE, fit, render};
use super::{Past, SHELL, head, tail};
use crate::archive::Entry;

/// The most of a line, and of the user's first message, in estimated tokens; of an answer's start.
const LINE: usize = 670;
const FIRST: usize = 800;
const ANSWER: usize = 60;
/// A line the ceiling shortened keeps this much of the user's words [§2.6, step 2].
const START: usize = 20;
/// Under the first message once the ceiling shortened any line.
const CEILING: &str = "  (To fit, older lines below show only their reference or start, and runs of them merge into range lines: `brigadier read` opens each whole.)\n";

/// One turn: the messages it took, the agent's words in it, and how it ended.
#[derive(Default)]
pub(super) struct Turn {
    pub took: Vec<String>,
    pub texts: Vec<String>,
    /// Its last text's entry, by index.
    pub answer: Option<usize>,
    /// done, cut, stopped or failed; empty while it runs.
    pub end: &'static str,
}

/// A turn begins at its CLI's start, or where none runs, at its first output after the messages it
/// takes, as the fold counts a turn from its input: some CLIs say it once for several.
pub(super) fn begin(
    turns: &mut Vec<Turn>,
    waiting: &mut Vec<String>,
    running: &mut bool,
    start: bool,
) {
    if start || !*running {
        let took = std::mem::take(waiting);
        turns.push(Turn {
            took,
            ..Default::default()
        });
        *running = true;
    }
}

/// The running turn ends `how`.
pub(super) fn end(turns: &mut [Turn], running: &mut bool, how: &'static str) {
    if let Some(t) = turns.last_mut().filter(|_| *running) {
        t.end = how;
    }
    *running = false;
}

/// A message the running turn takes, steered in, or else the next turn.
pub(super) fn took(turns: &mut [Turn], waiting: &mut Vec<String>, running: bool, at: &str) {
    match turns.last_mut().filter(|_| running) {
        Some(t) => t.took.push(at.into()),
        None => waiting.push(at.into()),
    }
}

/// A reference's place in log order: a fork's inherited lines, then the session's own frames.
pub(super) fn key(at: &str) -> (u8, u64) {
    match at.strip_prefix('i') {
        Some(n) => (0, n.parse().unwrap_or(0)),
        None => (1, at.parse().unwrap_or(0)),
    }
}

/// The longest start of `s` within `max` estimated tokens; none when it fits whole.
pub(super) fn upto(s: &str, max: usize) -> Option<&str> {
    if tokens(s) <= max {
        return None;
    }
    let mut ends: Vec<usize> = s.char_indices().map(|(i, _)| i).collect();
    ends.push(s.len());
    // `lo` fits, `hi` doesn't: the estimate only grows as a start does.
    let (mut lo, mut hi) = (0, ends.len() - 1);
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        match tokens(&s[..ends[mid]]) <= max {
            true => lo = mid,
            false => hi = mid,
        }
    }
    Some(&s[..ends[lo]])
}

/// "26 Nov 14:02", local time.
fn when(ms: u64) -> String {
    let secs = (ms / 1000) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month = months[tm.tm_mon as usize % 12];
    format!("{} {month} {:02}:{:02}", tm.tm_mday, tm.tm_hour, tm.tm_min)
}

/// `#a–b`, or `#a` alone.
fn range(id: &str, refs: &[String]) -> String {
    match (refs.first(), refs.last()) {
        (Some(a), Some(b)) if a != b => format!("{id}#{a}–{b}"),
        (Some(a), _) => format!("{id}#{a}"),
        _ => String::new(),
    }
}

/// Who an answer to the agent's question came from: only the user's own is theirs (O50).
fn answered_by(by: &str) -> &'static str {
    match by {
        "overnight" => "answered by Overnight, not the user",
        "review" => "answered by the reviewer, not the user",
        "parent" => "answered by your parent session, not the user",
        "brigadier" => "answered by Brigadier, not the user",
        _ => "the user's answer to your question",
    }
}

/// A numbered list item's line: `1.` or `1)` first.
fn numbered(l: &str) -> bool {
    let l = l.trim_start();
    let n = l.bytes().take_while(u8::is_ascii_digit).count();
    n > 0 && matches!(l.as_bytes().get(n), Some(b'.' | b')'))
}

/// A list item's line, numbered or bulleted.
fn item(l: &str) -> bool {
    numbered(l)
        || ["- ", "* ", "• "]
            .iter()
            .any(|m| l.trim_start().starts_with(m))
}

/// A short answer reads with what it answered [bugfix-1112 D221]: the agent's message just before
/// it, its numbered items for a numbered answer, the list it ends with, or else its end.
fn asked(id: &str, entries: &[Entry], i: usize, e: &Entry) -> String {
    let q = (entries[..i].iter().rev())
        .find(|q| q.from == "agent")
        .filter(|_| e.from == "user" && e.text.split_whitespace().count() <= 5);
    let Some(q) = q else {
        return String::new();
    };
    let text = q.text.trim_end();
    let items: Vec<&str> = if e.text.lines().any(numbered) {
        text.lines()
            .filter(|l| numbered(l) && !l.starts_with(char::is_whitespace))
            .collect()
    } else {
        let run = (text.lines().rev()).take_while(|l| l.trim().is_empty() || item(l));
        let mut run: Vec<&str> = run.filter(|l| item(l)).collect();
        run.reverse();
        run
    };
    let items: Vec<String> = items.iter().map(|l| head(l.trim(), 300)).collect();
    let end = match items.is_empty() {
        true => format!("…{}", tail(text, 300).replace('\n', " ")),
        false => head(&items.join(" "), 600),
    };
    format!(", answering your {id}#{}: {end}", q.at)
}

enum Row<'a> {
    Said(usize),
    Answer(&'a (String, String, String)),
    Carry(&'a Turn),
}

/// The conversation's section, its lines fitted to `budget` (the room less every other section, and
/// its half); none fits the small hand-off's. False when even the last step didn't fit.
pub(super) fn conversation(id: &str, p: &Past, budget: Option<(usize, usize)>) -> (String, bool) {
    let said = |e: &Entry| matches!(e.from, "user" | "worker" | "peer");
    let mut rows: Vec<((u8, u64), Row)> = (p.entries.iter().enumerate())
        .filter(|(_, e)| said(e))
        .map(|(i, e)| (key(&e.at), Row::Said(i)))
        .collect();
    rows.extend(p.answers.iter().map(|a| (key(&a.0), Row::Answer(a))));
    // A turn Brigadier started itself (a carry-on, the night) has a line of its own.
    let carried = (p.turns.iter()).filter(|t| t.took.is_empty());
    rows.extend(carried.filter_map(|t| Some((key(t.texts.first()?), Row::Carry(t)))));
    rows.sort_by_key(|r| r.0);
    let mine = |e: &&Entry| e.from == "user" && e.who.is_empty();
    let first = p.entries.iter().find(mine).map(|e| e.at.as_str());
    let newest = p.entries.iter().rev().find(mine).map(|e| e.at.as_str());
    let mut units = vec![];
    for (_, row) in &rows {
        let (at, who, text, context, user) = match *row {
            Row::Carry(t) => {
                let line = format!("- you, carrying on: {}\n", range(id, &t.texts));
                let refs = (t.texts[0].clone(), t.texts[t.texts.len() - 1].clone());
                let lines = [line.clone(), line.clone(), line];
                units.push(Unit::new(refs, false, Keep::No, t.texts.len(), lines));
                continue;
            }
            Row::Said(i) => {
                let e = &p.entries[i];
                let who = match e.from {
                    "worker" => format!("worker {}'s result", e.who),
                    "peer" => format!("session {}", e.who),
                    _ if !e.who.is_empty() => format!("the user, with `!`, {}", when(e.ts)),
                    _ => format!("the user, {}", when(e.ts)),
                };
                // Only a `!` command's report is held to its own cap first.
                let text = match e.from == "user" && !e.who.is_empty() {
                    true => head(e.text.trim_end(), SHELL),
                    false => e.text.trim_end().to_string(),
                };
                let user = e.from == "user";
                (e.at.as_str(), who, text, asked(id, &p.entries, i, e), user)
            }
            Row::Answer((at, text, by)) => (
                at.as_str(),
                answered_by(by).into(),
                text.trim_end().to_string(),
                String::new(),
                by.is_empty(),
            ),
        };
        let max = if first == Some(at) { FIRST } else { LINE };
        let shown = upto(&text, max).map_or(text.clone(), |start| {
            format!("{start}… ({id}#{at}, {} KiB)", text.len().div_ceil(1024))
        });
        // Shortened by the ceiling: the user's words to their start, anyone else's to the reference.
        let short = match (user, upto(&text, START)) {
            (true, Some(start)) => format!("- {id}#{at} ({who}): {start}…\n"),
            (true, None) => format!("- {id}#{at} ({who}): {text}\n"),
            (false, _) => format!("- {id}#{at} ({who})\n"),
        };
        let bare = context.split_once(": ").map_or("", |c| c.0);
        let keep = match () {
            _ if first == Some(at) => Keep::First,
            _ if newest == Some(at) => Keep::Newest,
            _ if !context.is_empty() => Keep::Pair,
            _ => Keep::No,
        };
        let lines = [
            format!("- {id}#{at} ({who}{context}): {shown}\n"),
            short,
            format!("- {id}#{at} ({who}{bare}): {shown}\n"),
        ];
        units.push(Unit::new((at.into(), at.into()), user, keep, 1, lines));
        // The turn that took it last: its answer's start and the rest it said [repo-merge D59].
        let Some(t) = (p.turns.iter()).find(|t| t.took.last().is_some_and(|l| l == at)) else {
            continue;
        };
        let line = match (t.end, t.texts.split_last()) {
            ("done", Some((last, rest))) => {
                let answer = t.answer.and_then(|i| p.entries.get(i));
                let answer = answer.map_or("", |e| e.text.trim());
                let start = upto(answer, ANSWER).map_or(answer.to_string(), |s| format!("{s}…"));
                let mut line = format!("  ↳ {id}#{last} you: {}", start.replace('\n', " "));
                if !rest.is_empty() {
                    line += &format!(" (said along the way: {})", range(id, rest));
                }
                line + "\n"
            }
            (end @ ("cut" | "stopped" | "failed"), texts) => {
                let words = texts.map_or(String::new(), |_| {
                    format!(": its words {}", range(id, &t.texts))
                });
                let carry = if end == "cut" {
                    "; the answer is the carry-on's"
                } else {
                    ""
                };
                format!("  ({end}{words}{carry})\n")
            }
            _ => continue,
        };
        let Some((a, b)) = t.texts.first().zip(t.texts.last()) else {
            continue;
        };
        let short = format!("  ↳ {} you\n", range(id, &t.texts));
        let short = if t.end == "done" { short } else { line.clone() };
        let lines = [line, short.clone(), short];
        units.push(Unit::new(
            (a.clone(), b.clone()),
            false,
            Keep::No,
            t.texts.len(),
            lines,
        ));
    }
    if units.is_empty() {
        return (String::new(), true);
    }
    let heading = format!(
        "\n## The conversation, oldest first\nA later line overrides an earlier one; only the last message is what's asked now. A line ending in … is only its start: read the whole of any that bears on your next step. Open one with `brigadier read {id}#<n> --around 0`, a range #a–b with `brigadier read {id}#a --to b`.\n"
    );
    let less = |n: usize| n.saturating_sub(tokens(&heading) + tokens(CEILING));
    let fits = fit(
        &mut units,
        budget.map(|(whole, half)| (less(whole), less(half))),
        id,
        key,
    );
    // The first message's line says what the ceiling shortened (rev 2 §4.1, step 5).
    if units.iter().any(|u| u.mode != WHOLE)
        && let Some(u) = units.iter_mut().find(|u| u.keep == Keep::First)
    {
        u.lines[u.mode] += CEILING;
    }
    (heading + &render(id, &units, key), fits)
}

/// One entry as the last exchange shows it: messages whole, steps on one short line, then where
/// their output is.
pub(super) fn line(id: &str, e: &Entry) -> String {
    let at = format!("{id}#{}", e.at);
    match e.from {
        "user" => format!("\n[{at} the user]\n{}\n", e.text.trim_end()),
        "worker" => format!(
            "\n[{at} worker {}'s result]\n{}\n",
            e.who,
            e.text.trim_end()
        ),
        "peer" => format!(
            "\n[{at} session {}'s message]\n{}\n",
            e.who,
            e.text.trim_end()
        ),
        "agent" => format!("\n[{at} you]\n{}\n", e.text.trim_end()),
        "cut" => "- stopped mid-way by Brigadier, not refused: redo it if still needed\n".into(),
        "stopped" => "- stopped by the user's Stop after any approval it had, not refused: it may have run, so check before redoing it\n".into(),
        "error" => format!(
            "- failed: {}\n",
            head(e.text.lines().next().unwrap_or(""), 200)
        ),
        _ if e.who.is_empty() => format!("- changed {}\n", e.files.join(", ")),
        _ => format!(
            "- {}: {}\n{}",
            e.who,
            head(e.text.lines().next().unwrap_or(""), 200),
            e.out
        ),
    }
}
