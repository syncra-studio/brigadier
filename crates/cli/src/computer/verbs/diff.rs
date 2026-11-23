//! What an action changed, by our own reads before and after it [D922]: the window's rows, from
//! Cua's own `since` read, and the app's windows that opened or closed, never an empty list [D2032].

use super::open::windows;
use super::window::{learn, mask, read, state_args, tidy, unresolved};
use super::{Sess, Words, call};
use serde_json::{Value, json};
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
    let (seen, text) = rows_changed(data, me, s, here);
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
    s.changed |= seen != Seen::No;
    (seen, text)
}

fn rows_changed(data: &Path, me: &str, s: &mut Sess, here: &dyn Fn() -> bool) -> (Seen, String) {
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
            Ok(text) => (Seen::Yes, format!("The window changed:\n{text}")),
            Err(_) => (
                Seen::Unsure,
                format!(
                    "Couldn't read {} after it: `brigadier computer read {}`.",
                    s.app, s.app
                ),
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
        ),
        Some("no_change") => (Seen::No, NO_CHANGE.into()),
        Some("diff") => {
            let diff = found["tree_diff"].as_str().unwrap_or("");
            s.moved |= diff.contains("\nreindexed:");
            let body = tidy(&mask(&diff.lines().skip(1).collect::<Vec<_>>().join("\n"), &s.secure));
            let rows: Vec<&str> = (body.lines())
                .filter(|l| l.trim_start().starts_with(['+', '-', '~']))
                .collect();
            if rows.is_empty() {
                return (Seen::Yes, outside(&found["diff_counts"]));
            }
            let more = match rows.len().saturating_sub(TOP) {
                0 => String::new(),
                n => format!("\n… and {n} more: read again for them."),
            };
            let moved = match s.moved {
                true => "\nThe numbers moved: read again before using them.",
                false => "",
            };
            (Seen::Yes, format!("Changed:\n{}{more}{moved}", rows[..rows.len().min(TOP)].join("\n")))
        }
        // Most of it changed (a page loaded): the window as it is now.
        Some("too_much_changed" | "diff_too_large") => {
            (s.secure, s.values, s.moved, s.address) = Default::default();
            learn(s, &found);
            let tree = tidy(&mask(found["tree_markdown"].as_str().unwrap_or(""), &s.secure));
            (Seen::Yes, format!("Most of the window changed; it reads now:\n{tree}"))
        }
        // No baseline to compare: the window as it is now, never called a change.
        _ => {
            (s.secure, s.values, s.moved, s.address) = Default::default();
            learn(s, &found);
            let tree = tidy(&mask(found["tree_markdown"].as_str().unwrap_or(""), &s.secure));
            match tree.trim().is_empty() {
                true => (Seen::Unsure, "I couldn't compare it with before, and the window reads empty now: read again.".into()),
                false => (Seen::Unsure, format!("I couldn't compare it with before; the window now:\n{tree}")),
            }
        }
    }
}
