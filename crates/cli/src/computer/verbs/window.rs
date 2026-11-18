//! One window as the agent reads it: its rows with password fields hidden, what changed since the
//! last read (Cua's own `since`), and a picture of it.

use super::{FULL, ROWS, SECURE, Sess, Words, call, refuse};
use brigadier_core as core;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

/// The tree's row number: `[N]` at the start of its row.
pub(super) fn row(line: &str) -> Option<u64> {
    let open = line.find('[')?;
    let close = open + line[open..].find(']')?;
    line[open + 1..close].parse().ok().filter(|_| {
        line[..open]
            .trim_start_matches([' ', '+', '~', '-'])
            .is_empty()
    })
}

/// Rows with a password field never print its value.
pub(super) fn mask(md: &str, secure: &HashSet<u64>) -> String {
    let hide = |line: &str| -> String {
        if !row(line).is_some_and(|n| secure.contains(&n)) {
            return line.to_string();
        }
        format!(
            "{} password field (hidden)",
            &line[..line.find(']').unwrap_or(0) + 1]
        )
    };
    md.lines().map(hide).collect::<Vec<_>>().join("\n")
}

/// Keeps what a read says of its rows: password fields and frames, by number.
pub(super) fn learn(s: &mut Sess, found: &Value) {
    for e in found["elements"].as_array().into_iter().flatten() {
        let Some(n) = e["element_index"].as_u64() else {
            continue;
        };
        match e["subrole"] == SECURE {
            true => drop(s.secure.insert(n)),
            false => drop(s.secure.remove(&n)),
        }
        if let Some(f) = e["frame"].as_object() {
            s.frames.insert(
                n,
                ["x", "y", "w", "h"].map(|k| f.get(k).and_then(Value::as_f64).unwrap_or(0.0)),
            );
        }
    }
    if let Some(id) = found["snapshot_id"].as_str() {
        s.snapshot = id.to_string();
    }
}

pub(super) fn state_args(s: &Sess, me: &str) -> Value {
    let (rows, depth) = if s.full { FULL } else { ROWS };
    let mut args = json!({"pid": s.pid, "window_id": s.window, "session": me, "tree_format": "both", "include_screenshot": false, "max_elements": rows, "max_depth": depth});
    if let Some(q) = &s.query {
        args["query"] = q.as_str().into();
    }
    args
}

/// One window, whole: its title, then its rows [D902].
pub(super) fn read(
    data: &Path,
    me: &str,
    s: &mut Sess,
    w: &Words,
    here: &dyn Fn() -> bool,
) -> Result<String, Value> {
    let windows = call(
        data,
        "list_windows",
        json!({"pid": s.pid, "on_screen_only": true}),
        here,
    )?;
    let all: Vec<Value> = (windows["windows"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter())
    .filter(|w| w["layer"].as_i64().unwrap_or(0) == 0)
    .collect();
    let nth: usize = w
        .values
        .get("--window")
        .and_then(|n| n.parse().ok())
        .unwrap_or(1);
    let window = all.get(nth.max(1) - 1).ok_or_else(|| match all.len() {
        0 => refuse(&format!("{} has no window open on this screen.", s.app)),
        n => refuse(&format!("{} has {n} windows: --window 1 to {n}.", s.app)),
    })?;
    s.window = window["window_id"].as_u64().unwrap_or(0);
    (s.query, s.full) = (
        w.values.get("--query").map(|q| q.to_string()),
        w.flags.contains("--full"),
    );
    let found = call(data, "get_window_state", state_args(s, me), here)?;
    (s.secure, s.frames, s.moved) = Default::default();
    learn(s, &found);
    let title = window["title"]
        .as_str()
        .filter(|t| !t.is_empty())
        .unwrap_or("untitled");
    let total = found["total_element_count"].as_u64().unwrap_or(0);
    let mut text = format!(
        "{} · \"{title}\" · window {nth} of {} · {total} elements\n{}",
        s.app,
        all.len(),
        mask(found["tree_markdown"].as_str().unwrap_or(""), &s.secure)
    );
    if found["truncated"] == true {
        text.push_str(&format!(
            "\n(Cut at {} rows: --query WORDS for one part, or --full for more.)",
            state_args(s, me)["max_elements"]
        ));
    }
    if found["returned_element_count"].as_u64().unwrap_or(0) < 3 {
        text.push_str("\nLooks visual: run `brigadier computer screenshot`.");
    }
    Ok(text)
}

/// What changed in the window since the last read, from Cua's own `since` read.
pub(super) fn changes(data: &Path, me: &str, s: &mut Sess, here: &dyn Fn() -> bool) -> String {
    let mut args = state_args(s, me);
    args["since"] = "latest".into();
    let Ok(found) = call(data, "get_window_state", args, here) else {
        return "Couldn't read the window after it: read again.".into();
    };
    learn(s, &found);
    match found["since_status"].as_str() {
        Some("no_change") => "No change in the window.".into(),
        Some("diff") => {
            let diff = found["tree_diff"].as_str().unwrap_or("");
            s.moved |= diff.contains("\nreindexed:");
            let body: Vec<&str> = diff.lines().skip(1).collect();
            let moved = if s.moved {
                "\nThe numbers moved: read again before using them."
            } else {
                ""
            };
            format!("Changed:\n{}{moved}", mask(&body.join("\n"), &s.secure))
        }
        _ => {
            (s.secure, s.moved) = Default::default();
            learn(s, &found);
            format!(
                "The window changed:\n{}",
                mask(found["tree_markdown"].as_str().unwrap_or(""), &s.secure)
            )
        }
    }
}

/// A drag between two controls' centres, in the window's picture pixels: one picture (it needs
/// Screen Recording) gives the window's place and scale, and is deleted at once (proposed).
pub(super) fn drag(
    data: &Path,
    me: &str,
    s: &Sess,
    from: u64,
    to: u64,
    here: &dyn Fn() -> bool,
) -> Result<Value, Value> {
    let frame = |n: u64| {
        s.frames.get(&n).copied().ok_or_else(|| {
            refuse(&format!(
                "[{n}] has no place on screen in your last read: read again."
            ))
        })
    };
    let (a, b) = (frame(from)?, frame(to)?);
    let file = std::env::temp_dir().join(format!("brigadier-drag-{}.png", std::process::id()));
    let shot = json!({"pid": s.pid, "window_id": s.window, "session": me, "include_accessibility_tree": false, "include_screenshot": true, "screenshot_out_file": file});
    let found = call(data, "get_window_state", shot, here);
    let _ = fs::remove_file(&file);
    let found = found?;
    let bounds = &found["window_bounds"];
    let (Some(x), Some(y), Some(scale)) = (
        bounds["x"].as_f64(),
        bounds["y"].as_f64(),
        found["screenshot_scale"].as_f64(),
    ) else {
        return Err(not_captured(&found));
    };
    let at = |f: [f64; 4]| {
        (
            (f[0] + f[2] / 2.0 - x) * scale,
            (f[1] + f[3] / 2.0 - y) * scale,
        )
    };
    let ((fx, fy), (tx, ty)) = (at(a), at(b));
    Ok(
        json!({"pid": s.pid, "window_id": s.window, "from_x": fx, "from_y": fy, "to_x": tx, "to_y": ty, "session": me}),
    )
}

/// The window as a picture in the session's folder, gone with it [D35]; only its path comes back.
pub(super) fn screenshot(
    data: &Path,
    me: &str,
    s: &Sess,
    here: &dyn Fn() -> bool,
) -> Result<String, Value> {
    if s.window == 0 {
        return Err(refuse(
            "Read a window first: brigadier computer read <app>.",
        ));
    }
    let dir = core::session_dir(data, me).join("computer");
    fs::create_dir_all(&dir).map_err(|e| refuse(&e.to_string()))?;
    let n = fs::read_dir(&dir).map_or(0, |d| d.count()) + 1;
    let file = dir.join(format!("{n}.jpg"));
    let shot = json!({"pid": s.pid, "window_id": s.window, "session": me, "include_accessibility_tree": false, "include_screenshot": true, "screenshot_out_file": file, "screenshot_format": "jpeg", "max_dimension": 1366});
    let found = call(data, "get_window_state", shot, here)?;
    if found["screenshot_file_path"].is_null() {
        return Err(not_captured(&found));
    }
    let size = match (
        found["screenshot_width"].as_u64(),
        found["screenshot_height"].as_u64(),
    ) {
        (Some(w), Some(h)) => format!(" ({w}×{h})"),
        _ => String::new(),
    };
    Ok(format!("Saved: {}{size}", file.display()))
}

/// A capture the driver couldn't make or place, in its own words.
fn not_captured(found: &Value) -> Value {
    let why = found["screenshot_error"]["code"]
        .as_str()
        .unwrap_or("no picture came back");
    refuse(&format!(
        "Couldn't capture the window: {why}. Read it again."
    ))
}
