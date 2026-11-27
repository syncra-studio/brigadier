//! What an action changed, by our own reads before and after it [D922]: the window's rows, from
//! Cua's own `since` read, and the app's windows that opened or closed, never an empty list [D2032].

use super::open::windows;
use super::window::{
    chromium, in_cells, learn, mask, no_page, page_missing, read, row, state_args, tidy, unresolved,
};
use super::{Sess, Words, call};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;
use std::thread;
use std::time::Duration;

/// What an action did, by our own reads before and after it [D922].
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Seen {
    Yes,
    No,
    /// Something we couldn't compare: never said as "no change".
    Unsure,
}

pub(super) const NO_CHANGE: &str = "No change in the window.";

/// The most changed rows listed; the rest are counted.
const TOP: usize = 40;

/// The app's windows just before an action, so one it opens or closes is a change too. The
/// window's own rows are diffed against the last read: a new read would void its numbers.
pub(super) fn baseline(data: &Path, s: &mut Sess, here: &dyn Fn() -> bool) {
    s.wins = titles(data, s, here);
}

/// The app's windows, less the untitled ones accessibility sees nothing in: Chromium keeps such a
/// window that comes and goes, and it moved the count and the default window [D2032].
pub(super) fn live(data: &Path, s: &Sess, here: &dyn Fn() -> bool) -> Result<Vec<Value>, Value> {
    let mut all = windows(data, s.pid, here)?;
    if all.len() > 1 {
        // Titled ones too, as a "Loading" window can be empty. The probe has no session, so the
        // next diff's base stays.
        all.retain(|w| {
            let wid = w["window_id"].as_u64().unwrap_or(0);
            wid == s.window
                || call(data, "get_window_state", json!({"pid": s.pid, "window_id": wid, "include_screenshot": false, "max_elements": 4, "max_depth": 4}), here)
                    .is_ok_and(|f| !unresolved(&f) && f["total_element_count"].as_u64().unwrap_or(0) > 0)
        });
    }
    Ok(all)
}

fn titles(data: &Path, s: &Sess, here: &dyn Fn() -> bool) -> Vec<(u64, String)> {
    let all = live(data, s, here).unwrap_or_default();
    (all.iter())
        .map(|w| {
            let title = w["title"].as_str().unwrap_or("");
            (w["window_id"].as_u64().unwrap_or(0), title.to_string())
        })
        .collect()
}

/// What changed since the baseline: the window's rows, from Cua's own `since` read, and the app's
/// windows that opened or closed.
pub(super) fn changes(
    data: &Path,
    me: &str,
    s: &mut Sess,
    here: &dyn Fn() -> bool,
) -> (Seen, String) {
    let (seen, text, whole) = rows_changed(data, me, s, here);
    let (lines, pageless, alike) = controls_changed(data, s, seen, whole, here);
    let (seen, text) = match lines {
        lines if lines.is_empty() && alike && seen == Seen::No => (
            Seen::Unsure,
            "What's selected, or the order, changed among controls that read the same: I can't tell which. Read again.".into(),
        ),
        lines if lines.is_empty() => (seen, text),
        lines if seen == Seen::No => (Seen::Yes, format!("Changed:\n{}", lines.join("\n"))),
        lines => (seen, format!("{text}\n{}", lines.join("\n"))),
    };
    let now = titles(data, s, here);
    let name = |t: &str| match t {
        "" => "untitled".to_string(),
        t => format!("\"{t}\""),
    };
    let mut wins: Vec<String> = (now.iter())
        .filter(|w| !s.wins.iter().any(|b| b.0 == w.0))
        .map(|w| format!("+ window {} (--window {})", name(&w.1), w.0))
        .collect();
    wins.extend(
        (s.wins.iter())
            .filter(|b| !now.iter().any(|w| w.0 == b.0))
            .map(|b| format!("- window {}", name(&b.1))),
    );
    // Another window kept but retitled, as a page that saved in it.
    // shortcut: only its title is compared; diff its rows too if a change inside one goes unseen.
    wins.extend((now.iter()).filter(|w| w.0 != s.window).filter_map(|w| {
        let b = s.wins.iter().find(|b| b.0 == w.0 && b.1 != w.1)?;
        Some(format!(
            "~ window {} is now {} (--window {})",
            name(&b.1),
            name(&w.1),
            w.0
        ))
    }));
    s.wins = now;
    let (seen, text) = match (seen, wins.is_empty()) {
        (_, true) => (seen, text),
        (Seen::No, false) => (
            Seen::Yes,
            format!("The app's windows changed:\n{}", wins.join("\n")),
        ),
        (seen, false) => (
            seen,
            format!("{text}\nThe app's windows changed:\n{}", wins.join("\n")),
        ),
    };
    // A page it can't read may have changed, whatever else did or didn't.
    let (seen, text) = match pageless && chromium(data, s.pid, here) {
        true => unread(seen, &text, &s.app),
        false => (seen, text),
    };
    s.changed |= seen != Seen::No;
    (seen, text)
}

/// A change told without the page: never "no change" [D2032].
fn unread(seen: Seen, text: &str, app: &str) -> (Seen, String) {
    let note = format!(
        "{app}'s page can't be read, so what this changed in it is unknown. {}",
        no_page(app)
    );
    match seen {
        Seen::No => (Seen::Unsure, note),
        seen if text.contains(&no_page(app)) => (seen, text.to_string()),
        seen => (seen, format!("{text}\n{note}")),
    }
}

/// A control of a read. Numbers shift, so it's known by what it reads: hashes of its rows, then of
/// its parent's, up to the window.
#[derive(Clone)]
pub(super) struct Control {
    pub(super) role: String,
    pub(super) n: u64,
    pub(super) name: String,
    on: Option<bool>,
    at: Option<[f64; 2]>,
    pub(super) reads: Vec<u64>,
    /// A text field in a table's cell, as a file's name is in Finder.
    pub(super) cell: bool,
}

pub(super) fn controls(found: &Value) -> Vec<Control> {
    let md = found["tree_markdown"].as_str().unwrap_or("");
    let (rows, cells) = (reads(md), in_cells(md));
    let all = found["elements"].as_array().into_iter().flatten();
    all.map(|e| {
        let s = |k: &str| e[k].as_str().unwrap_or("").to_string();
        let f = e["frame"].as_object();
        let n = e["element_index"].as_u64().unwrap_or(0);
        let on = e["selected"].as_bool();
        Control {
            role: s("role"),
            n,
            name: s("label"),
            on,
            at: f.map(|f| ["x", "y"].map(|k| f.get(k).and_then(Value::as_f64).unwrap_or(0.0))),
            reads: (rows.get(&n).cloned()).unwrap_or_default(),
            cell: cells.contains(&n),
        }
    })
    .collect()
}

/// By number, what a row and the rows under it read, less their numbers; then its parent's, and up.
fn reads(md: &str) -> HashMap<u64, Vec<u64>> {
    // Each row's number, parent and hash, and the rows open above the line, with their depth.
    let mut rows: Vec<(Option<u64>, Option<usize>, DefaultHasher)> = vec![];
    let mut open: Vec<(usize, usize)> = vec![];
    for line in md.lines() {
        let depth = line.len() - line.trim_start().len();
        let mut text = line.trim_start();
        // Any other line is the rest of a value that has line breaks.
        if text.starts_with("- ") {
            open.retain(|o| o.0 < depth);
            let n = row(line.trim_start());
            rows.push((n, open.last().map(|o| o.1), DefaultHasher::new()));
            open.push((depth, rows.len() - 1));
            if n.is_some() {
                text = text.split_once(']').map_or(text, |t| t.1);
            }
        }
        for (_, i) in &open {
            text.hash(&mut rows[*i].2);
        }
    }
    let up = |i: usize| {
        std::iter::successors(Some(i), |&i| rows[i].1)
            .map(|i| rows[i].2.finish())
            .collect()
    };
    (rows.iter().enumerate())
        .filter_map(|(i, r)| Some((r.0?, up(i))))
        .collect()
}

/// What the driver's rows don't print, so its diff can't hold: a control selected or no longer, and
/// content that moved, as a list that scrolled [D2032]. Its read, unless the last one was `whole`,
/// has no session: the next diff's base stays. Also whether it lacks the page it should hold, which
/// isn't told when it failed, and whether controls that read alike differ.
fn controls_changed(
    data: &Path,
    s: &mut Sess,
    seen: Seen,
    whole: Option<Value>,
    here: &dyn Fn() -> bool,
) -> (Vec<String>, bool, bool) {
    let mut args = state_args(s, "");
    if let Some(a) = args.as_object_mut() {
        a.remove("session");
    }
    // shortcut: a whole read more per action, in native apps too. Skipped where rows changed, the
    // next action's selection would be told against an older one, or not at all.
    let Some(found) = whole.or_else(|| call(data, "get_window_state", args, here).ok()) else {
        return (vec![], false, false);
    };
    let now = controls(&found);
    let was = std::mem::replace(&mut s.controls, now);
    let (lines, alike) = said(&was, &s.controls, seen);
    (lines, page_missing(&found), alike)
}

/// The lines for what differs between two reads' controls, and whether some differ that read the
/// same, so which of them it is can't be told, as of two rows with one name that changed places.
fn said(was: &[Control], now: &[Control], seen: Seen) -> (Vec<String>, bool) {
    type Alike<'a> = HashMap<(&'a str, &'a str, &'a [u64]), Vec<&'a Control>>;
    fn group(all: &[Control], rows: usize) -> Alike<'_> {
        let mut out = Alike::new();
        for c in all.iter().filter(|c| c.reads.len() >= rows) {
            let key = (c.role.as_str(), c.name.as_str(), &c.reads[..rows]);
            out.entry(key).or_default().push(c);
        }
        out
    }
    let mut picked: Vec<(u64, String)> = vec![];
    // One that came or went says so in its own row.
    let mut left: Vec<&Control> = (now.iter()).filter(|c| c.on.is_some()).collect();
    let mut alike = false;
    for rows in 1.. {
        let (before, after) = (group(was, rows), group(now, rows));
        left.retain(|c| {
            let key = (
                c.role.as_str(),
                c.name.as_str(),
                match c.reads.get(..rows) {
                    Some(r) => r,
                    None => return false,
                },
            );
            let (Some(a), Some(b)) = (before.get(&key), after.get(&key)) else {
                return false;
            };
            if let (&[a], &[b]) = (&a[..], &b[..]) {
                let line = match (a.on, b.on) {
                    (Some(false) | None, Some(true)) => "selected",
                    (Some(true), Some(false)) => "no longer selected",
                    _ => return false,
                };
                picked.push((
                    c.n,
                    format!("~ [{}] {} \"{}\": {line}", c.n, c.role, c.name),
                ));
                return false;
            }
            // Alike all the way up: only how they're selected, in order, can differ.
            if rows == c.reads.len() {
                let on = |all: &[&Control]| all.iter().map(|c| c.on).collect::<Vec<_>>();
                alike |= on(a) != on(b);
            }
            rows < c.reads.len()
        });
        if left.is_empty() {
            break;
        }
    }
    picked.sort();
    let mut lines: Vec<String> = picked.into_iter().map(|p| p.1).take(TOP).collect();
    // Only where no row changed, so each control is in its place in the list: a change of layout
    // moves rows too, and its rows say what it was.
    let mut moved: HashMap<(i64, i64), usize> = HashMap::new();
    if seen == Seen::No && was.len() == now.len() {
        for (a, b) in was.iter().zip(now) {
            if let (Some(a), Some(b)) = (a.at, b.at) {
                let by = ((b[0] - a[0]).round() as i64, (b[1] - a[1]).round() as i64);
                if by != (0, 0) {
                    *moved.entry(by).or_default() += 1;
                }
            }
        }
    }
    let most = moved.into_iter().max_by_key(|m| m.1);
    if let Some(((x, y), n)) = most.filter(|m| m.1 > 1) {
        let way = match (x, y) {
            (0, y) if y < 0 => format!("up {} points", -y),
            (0, y) => format!("down {y} points"),
            (x, y) => format!("by {x},{y} points"),
        };
        lines.push(format!(
            "~ {n} controls moved {way}, as when a list scrolls"
        ));
    }
    (lines, alike)
}

/// What the driver's diff says, and the read itself where it came back whole, with no diff.
fn rows_changed(
    data: &Path,
    me: &str,
    s: &mut Sess,
    here: &dyn Fn() -> bool,
) -> (Seen, String, Option<Value>) {
    let mut args = state_args(s, me);
    // The last read, named: a second look diffs against it too, not against the first look.
    args["since"] = match s.snapshot.is_empty() {
        true => "latest".into(),
        false => s.snapshot.clone().into(),
    };
    let mut found = call(data, "get_window_state", args.clone(), here);
    // Chromium's tree trails a click a moment: "no change" only after a second look.
    if found
        .as_ref()
        .is_ok_and(|f| f["since_status"] == "no_change")
    {
        thread::sleep(Duration::from_millis(500));
        found = call(data, "get_window_state", args, here);
    }
    let Ok(found) = found else {
        // The window went (a panel closed, a document replaced it): read what the app shows now.
        let again = Words {
            verb: "read",
            rest: vec![],
            values: Default::default(),
            flags: Default::default(),
        };
        return match read(data, me, s, &again, here) {
            Ok(text) => (Seen::Yes, format!("The window changed:\n{text}"), None),
            Err(_) => (
                Seen::Unsure,
                format!(
                    "Couldn't read {} after it: `brigadier computer read {}`.",
                    s.app, s.app
                ),
                None,
            ),
        };
    };
    learn(s, &found);
    let outside = |n: &Value| {
        format!(
            "Changed, but outside what I can diff ({} added, {} changed, {} removed by the driver's count): read again.",
            n["added"], n["changed"], n["removed"]
        )
    };
    match found["since_status"].as_str() {
        // Past the row budget the reads stop, and so does the diff.
        Some("no_change") if found["truncated"] == true => (
            Seen::Unsure,
            "No change in the rows I compare, but the window has more past them: `read --full` shows it all.".into(),
            None,
        ),
        Some("no_change") => (Seen::No, NO_CHANGE.into(), None),
        Some("diff") => {
            let diff = found["tree_diff"].as_str().unwrap_or("");
            s.moved |= diff.contains("\nreindexed:");
            let body = tidy(&mask(&diff.lines().skip(1).collect::<Vec<_>>().join("\n"), &s.secure));
            let rows: Vec<&str> = (body.lines())
                .filter(|l| l.trim_start().starts_with(['+', '-', '~']))
                .collect();
            if rows.is_empty() {
                return (Seen::Yes, outside(&found["diff_counts"]), None);
            }
            let more = match rows.len().saturating_sub(TOP) {
                0 => String::new(),
                n => format!("\n… and {n} more: read again for them."),
            };
            let moved = match s.moved {
                true => "\nThe numbers moved: read again before using them.",
                false => "",
            };
            (Seen::Yes, format!("Changed:\n{}{more}{moved}", rows[..rows.len().min(TOP)].join("\n")), None)
        }
        // Most of it changed (a page loaded): the window as it is now.
        Some("too_much_changed" | "diff_too_large") => {
            (s.secure, s.values, s.moved, s.address) = Default::default();
            learn(s, &found);
            let tree = tidy(&mask(found["tree_markdown"].as_str().unwrap_or(""), &s.secure));
            (Seen::Yes, format!("Most of the window changed; it reads now:\n{tree}"), Some(found))
        }
        // No baseline to compare: the window as it is now, never called a change.
        _ => {
            (s.secure, s.values, s.moved, s.address) = Default::default();
            learn(s, &found);
            let tree = tidy(&mask(found["tree_markdown"].as_str().unwrap_or(""), &s.secure));
            match tree.trim().is_empty() {
                true => (Seen::Unsure, "I couldn't compare it with before, and the window reads empty now: read again.".into(), Some(found)),
                false => (Seen::Unsure, format!("I couldn't compare it with before; the window now:\n{tree}"), Some(found)),
            }
        }
    }
}
