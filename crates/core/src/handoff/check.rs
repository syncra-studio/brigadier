//! The summary's check [repo-merge D85; rev 3 §2.4]: in under a second, with no model call, each
//! quote is found in the record or marked, each line that speaks for the user is sent to the
//! user's own message, and each path and commit is looked for. It only labels: nothing is
//! deleted, and it can't prove a line reads its source right, so the records stay the authority.

use crate::adapters::setup;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Where a quote was found: an item written before the summary input, under its reference.
#[derive(Clone)]
struct Cite {
    at: String,
    /// The user's own words: their message or their answer.
    user: bool,
    /// A tool's input or whole output, opened by `read --raw`.
    tool: bool,
}

/// A summary's quotes, each with the newest item that holds it and the newest of the user's own,
/// filled item by item as the record is read, so no item's words are kept past their look.
pub struct Found(HashMap<String, (Option<Cite>, Option<Cite>)>);

impl Found {
    pub fn new(text: &str) -> Found {
        let quotes = text.lines().flat_map(quotes).map(|(_, q)| q);
        Found(
            quotes
                .filter(|q| !q.is_empty())
                .map(|q| (q, (None, None)))
                .collect(),
        )
    }

    /// One item the summary may cite, oldest first: `user` the user's own words, `tool` a tool's.
    pub fn see(&mut self, at: &str, text: &str, user: bool, tool: bool) {
        let text = fold(text);
        for (_, (any, theirs)) in self.0.iter_mut().filter(|(q, _)| text.contains(q.as_str())) {
            let c = Some(Cite {
                at: at.into(),
                user,
                tool,
            });
            if user {
                theirs.clone_from(&c);
            }
            *any = c;
        }
    }

    fn newest(&self, q: &str, user: bool) -> Option<&Cite> {
        let (any, theirs) = self.0.get(q)?;
        if user { theirs } else { any }.as_ref()
    }
}

/// Each «quote» in a line, folded, with the offset in the line just past its `»`.
fn quotes(body: &str) -> Vec<(usize, String)> {
    let (mut out, mut rest) = (vec![], body);
    while let Some(open) = rest.find('«') {
        let Some(len) = rest[open..].find('»') else {
            break;
        };
        let at = body.len() - rest.len() + open + len + '»'.len_utf8();
        out.push((at, fold(&rest[open + '«'.len_utf8()..open + len])));
        rest = &rest[open + len + '»'.len_utf8()..];
    }
    out
}

/// Whitespace- and case-folded, as quotes and sources are compared.
pub fn fold(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Words that give a line as the user's: their words, an approval, a rule or a correction.
const USERS: &[&str] = &[
    "you said",
    "you asked",
    "you approved",
    "you wanted",
    "you allowed",
    "you told",
    "user said",
    "user asked",
    "user approved",
    "user wants",
    "user wanted",
    "user allowed",
    "user told",
    "user set",
    "user corrected",
    "user decided",
    "user agreed",
    "user confirmed",
    "user chose",
    "user rejected",
    "user requested",
    "user prefers",
    "user's rule",
];

/// A word that may name a commit: 7 to 40 hex digits, a digit and a letter among them.
fn hash(w: &str) -> bool {
    (7..=40).contains(&w.len())
        && w.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        && w.chars().any(|c| c.is_ascii_digit())
        && w.chars().any(|c| c.is_ascii_alphabetic())
}

/// The file a backticked word names: a path with a `/`, or a bare name such as `Cargo.toml` or
/// `.env`; a `:12` or `:12:5` line after it is no part of it.
fn named(p: &str) -> Option<&str> {
    let mut p = p;
    for _ in 0..2 {
        let line = p
            .rsplit_once(':')
            .filter(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
        p = line.map_or(p, |(head, _)| head);
    }
    if p.contains(char::is_whitespace) || p.contains("://") {
        return None;
    }
    let ext = p.rsplit_once('.').is_some_and(|(_, e)| {
        e.len() <= 10
            && e.bytes().any(|b| b.is_ascii_alphabetic())
            && e.bytes().all(|b| b.is_ascii_alphanumeric())
    });
    let bare = ext
        && p.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
    (p.contains('/') || bare).then_some(p)
}

/// Which of `hashes` name a commit in `cwd`'s repository, asked in one bounded call that never
/// fetches: None outside a repository; Err when git didn't answer, so each is marked unchecked.
fn commits<'a>(cwd: &str, hashes: &[&'a str]) -> Option<Result<HashSet<&'a str>, ()>> {
    if hashes.is_empty() {
        return Some(Ok(HashSet::new()));
    }
    let ask: String = hashes.iter().map(|h| format!("{h}^{{commit}}\n")).collect();
    let mut git = super::text::git_in(cwd);
    git.args(["cat-file", "--batch-check"]);
    let stop = std::sync::atomic::AtomicBool::new(false);
    let out = match setup::run_fed(&mut git, super::text::GIT_SECS, &stop, Some(&ask)) {
        Ok(o) if o.status.success() => o,
        Ok(_) => return None,
        Err(_) => return Some(Err(())),
    };
    let found = String::from_utf8_lossy(&out.stdout);
    // One answer a line, in order: `<sha> commit <size>`, or the question then `missing`.
    let yes = hashes.iter().zip(found.lines());
    let yes = yes.filter(|(_, l)| l.split(' ').nth(1) == Some("commit"));
    Some(Ok(yes.map(|(h, _)| *h).collect()))
}

/// Checks `text` against where its quotes were `found`, in folder `cwd`; `was` is the folder the
/// record's paths were under, for a fork that moved. Gives `cites`, `marks` and `check` for the
/// note; each `at` is a byte offset in `text`, where the cite or mark is shown.
pub fn check(text: &str, found: &Found, cwd: &str, was: Option<&str>) -> Value {
    let (mut cites, mut marks) = (vec![], vec![]);
    let mut n = json!({"lines": 0, "found": 0, "missing": 0, "no_source": 0, "user_claims": 0,
        "not_users": 0, "paths_missing": 0, "commits_missing": 0, "commits_unchecked": 0});
    let mut bump = |k: &str| n[k] = (n[k].as_u64().unwrap_or(0) + 1).into();
    let words = text.split(|c: char| !c.is_ascii_alphanumeric());
    let mut hashes: Vec<&str> = words.filter(|w| hash(w)).collect();
    hashes.sort_unstable();
    hashes.dedup();
    let known = commits(cwd, &hashes);
    let mut start = 0;
    for line in text.split_inclusive('\n') {
        let base = start;
        start += line.len();
        let body = line.trim_end();
        let end = base + body.len();
        let bare = body.trim_start_matches(['-', '*', ' ']).trim();
        if bare.is_empty() || body.starts_with('#') || bare.eq_ignore_ascii_case("nothing.") {
            continue;
        }
        bump("lines");
        let lower = body.to_lowercase();
        let claim = USERS.iter().any(|w| lower.contains(w));
        // Each «quote», looked for newest first; the user's own words first for a line given as theirs.
        let (mut quoted, mut by_user, mut by_other) = (false, None, None);
        for (at, q) in quotes(body) {
            let at = base + at;
            if q.is_empty() {
                continue;
            }
            quoted = true;
            let newest = |user: bool| found.newest(&q, user);
            match (claim.then(|| newest(true)).flatten()).or_else(|| newest(false)) {
                Some(s) => {
                    bump("found");
                    cites.push(json!({"at": at, "ref": s.at, "tool": s.tool}));
                    if s.user {
                        by_user.get_or_insert(s.at.clone());
                    } else {
                        by_other.get_or_insert(s.at.clone());
                    }
                }
                None => {
                    bump("missing");
                    marks.push(json!({"at": at, "kind": "missing"}));
                }
            }
        }
        if !quoted && !lower.contains("(from memory)") {
            bump("no_source");
            marks.push(json!({"at": end, "kind": "no_source"}));
        }
        // It never stands as the user's word: the records hold their own messages.
        if claim {
            bump("user_claims");
            let mark = match (by_user, by_other) {
                (Some(r), _) => json!({"at": end, "kind": "user", "ref": r}),
                (None, Some(r)) => json!({"at": end, "kind": "not_users", "ref": r}),
                (None, None) => json!({"at": end, "kind": "no_user"}),
            };
            if mark["kind"] != "user" {
                bump("not_users");
            }
            marks.push(mark);
        }
        // `paths` as the agent would read them; a fork's moved ones under its own folder.
        let mut ticks = body.split('`');
        let mut off = base + ticks.next().map_or(0, str::len) + 1;
        while let (Some(p), Some(after)) = (ticks.next(), ticks.next()) {
            let path = named(p).map(|p| match (was, p.starts_with('/')) {
                (Some(w), true) if p.starts_with(w) => format!("{cwd}{}", &p[w.len()..]),
                (_, true) => p.to_string(),
                _ => format!("{cwd}/{p}"),
            });
            if path.is_some_and(|p| !Path::new(&p).exists()) {
                bump("paths_missing");
                marks.push(json!({"at": off + p.len() + 1, "kind": "path"}));
            }
            off += p.len() + 1 + after.len() + 1;
        }
        // A commit named by its hash, in that folder's repository: a blob's or a tree's fails too.
        if let Some(known) = &known {
            let mut at = base;
            for w in body.split(|c: char| !c.is_ascii_alphanumeric()) {
                let here = body[at - base..].find(w).map_or(at, |i| at + i);
                at = here + w.len();
                let kind = match known {
                    _ if !hash(w) => continue,
                    Ok(yes) if yes.contains(w) => continue,
                    Ok(_) => "commit",
                    Err(()) => "unchecked",
                };
                bump(if kind == "commit" {
                    "commits_missing"
                } else {
                    "commits_unchecked"
                });
                marks.push(json!({"at": at, "kind": kind}));
            }
        }
    }
    json!({"cites": cites, "marks": marks, "check": n})
}

/// The checked text as the hand-off shows it: each cite and mark in its place, `#n` under
/// session `id`; one a fork's copy didn't take reads "(not in this fork)".
pub fn render(id: &str, note: &Value) -> String {
    let text = note["text"].as_str().unwrap_or("");
    let r = |v: &Value| v["ref"].as_str().map(String::from);
    let gone = "(not in this fork)".to_string();
    let mut at: Vec<(usize, String)> = vec![];
    for c in note["cites"].as_array().into_iter().flatten() {
        let shown = match (r(c), c["tool"] == true) {
            (Some(n), true) => format!(" (source: `brigadier read {id}#{n} --raw`)"),
            (Some(n), false) => format!(" (source {id}#{n})"),
            (None, _) => format!(" {gone}"),
        };
        at.push((c["at"].as_u64().unwrap_or(0) as usize, shown));
    }
    for m in note["marks"].as_array().into_iter().flatten() {
        let n = r(m).map_or(gone.clone(), |n| format!("{id}#{n}"));
        let shown = match m["kind"].as_str().unwrap_or("") {
            "missing" => "(not found in the record)".into(),
            "no_source" => "(no source given)".into(),
            "user" => format!("(check the user's own message {n})"),
            "not_users" => format!("(not the user's words: from {n})"),
            "no_user" => "(no user message says this)".into(),
            "path" => "(not on disk now)".into(),
            "unchecked" => "(commit not checked)".into(),
            _ => "(no such commit)".into(),
        };
        at.push((m["at"].as_u64().unwrap_or(0) as usize, format!(" {shown}")));
    }
    // From the end, so each offset still points where it did; the same offset keeps its order.
    at.sort_by_key(|(a, _)| *a);
    let mut out = text.to_string();
    for (a, s) in at.into_iter().rev() {
        if a <= out.len() && out.is_char_boundary(a) {
            out.insert_str(a, &s);
        }
    }
    out
}

/// The opening note's last sentence, with a summary and without [rev 3 §2.5].
pub const SUMMARY: &str = "The summary below was written by the conversation before this one; it's a summary, not a record. Everything after it is copied from the record and wins where they differ. The user's approvals, rules and corrections count only as written in their own messages there.";
pub const RECORD: &str = "Everything below is copied from the record.";

/// The most of a summary a hand-off shows, in estimated tokens [rev 3 §2.5].
pub const SHOWN: usize = 6_000;

/// The hand-off's summary section: the note at reference `at`, written `ago` renewals before
/// this one (0: for this one), checked and capped at `shown`, its whole text one command away.
pub fn section(id: &str, at: &str, note: &Value, ago: usize, shown: usize) -> String {
    let s = |k: &str| note[k].as_str().unwrap_or("");
    let head = match ago {
        0 => format!(
            "written by {} as its conversation ended ({id}#{}–{})",
            s("model"),
            s("from"),
            s("to")
        ),
        n => format!(
            "written by {} at {id}#{}, {n} renewal{} ago; what happened since is only in the records below",
            s("model"),
            s("to"),
            if n == 1 { "" } else { "s" }
        ),
    };
    let (mut body, mut left) = (String::new(), false);
    for line in render(id, note).split_inclusive('\n') {
        // Its headings sit under the hand-off's own section, not beside them.
        let line = if line.starts_with("## ") {
            format!("#{line}")
        } else {
            line.into()
        };
        left |= super::estimate::tokens(&body) + super::estimate::tokens(&line) > shown;
        if !left {
            body += &line;
        }
    }
    if left {
        let (gap, what) = match body.is_empty() {
            true => ("", "left out to fit the room"),
            false => ("\n", "the rest"),
        };
        body += &format!("{gap}… ({what}: `brigadier read {id}#{at} --raw`)");
    }
    format!("\n## Summary, {head}\n{}\n", body.trim_end())
}

/// A fork's copy, `refs` each item's reference in its source: each summary note's references
/// become the copy's own `i<line>`, a fork's of a fork's too; one past the fork point is none
/// [rev 3 §3]. shortcut: a frame of several items maps to its first line; key cites by item if a
/// step's call and output ever share a frame.
pub fn copied(items: &mut [Value], refs: Vec<String>) {
    let mut line = std::collections::HashMap::new();
    for (n, r) in refs.into_iter().enumerate() {
        line.entry(r).or_insert(format!("i{n}"));
    }
    let to = |v: &Value| v.as_str().and_then(|r| line.get(r)).cloned().into();
    for item in items.iter_mut().filter(|i| i["event"] == "summary") {
        (item["from"], item["to"]) = (to(&item["from"]), to(&item["to"]));
        for k in ["cites", "marks"] {
            (item[k].as_array_mut().into_iter().flatten())
                .filter(|c| !c["ref"].is_null())
                .for_each(|c| c["ref"] = to(&c["ref"]));
        }
    }
}
