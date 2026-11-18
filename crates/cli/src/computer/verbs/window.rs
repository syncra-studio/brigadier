//! One window as the agent reads it: its rows with password fields hidden, what changed since the
//! last read (Cua's own `since`), and a picture of it.

use super::open::{menu_bar, own, windows};
use super::{FULL, ROWS, SECURE, Sess, Words, call, lock, refuse};
use brigadier_core as core;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use std::{fs, thread};

/// Below this many elements a window reads as thin: Chromium and Electron keep their tree off
/// until a client asks, and Cua asks only apps on its list (#7751), so Dia read empty.
const THIN: u64 = 12;
/// How long the first thin read waits for the tree to fill (Chromium builds it ~2 s after asked).
const THIN_WAIT: Duration = Duration::from_secs(3);
/// The apps asked to turn their tree on already, by pid: each is asked, and waited on, once.
static ASKED: LazyLock<Mutex<HashSet<i64>>> = LazyLock::new(Mutex::default);

/// Chromium and Electron take AXManualAccessibility, native apps refuse it (-25205): asked once
/// per pid, which also turns their tree on.
static CHROMIUM: LazyLock<Mutex<HashMap<i64, bool>>> = LazyLock::new(Mutex::default);

pub(super) fn chromium(data: &Path, pid: i64, here: &dyn Fn() -> bool) -> bool {
    if let Some(&c) = lock(&CHROMIUM).get(&pid) {
        return c;
    }
    let c = own(data, "enable", json!({"pid": pid}), here).is_ok_and(|r| r["manual"] == 0);
    lock(&CHROMIUM).insert(pid, c);
    c
}

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
    let all = windows(data, s.pid, here)?;
    if all.is_empty() {
        (s.window, s.snapshot, s.secure, s.frames) = Default::default();
        return menu_bar(data, s, here);
    }
    let asked: Option<usize> = (w.values.get("--window")).and_then(|n| n.parse().ok());
    if asked.is_some_and(|n| n == 0 || n > all.len()) {
        return Err(refuse(&format!(
            "{} has {} windows: --window 1 to {}.",
            s.app,
            all.len(),
            all.len()
        )));
    }
    (s.query, s.full) = (
        w.values.get("--query").map(|q| q.to_string()),
        w.flags.contains("--full"),
    );
    // Unasked, the first window accessibility knows: list_windows keeps closed ones a while (Cua
    // #4038), and those read as nothing.
    // The window the session is in comes first.
    let order: Vec<usize> = match asked {
        Some(n) => vec![n - 1],
        None => {
            let mut all_i: Vec<usize> = (0..all.len()).collect();
            all_i.sort_by_key(|&i| all[i]["window_id"].as_u64() != Some(s.window));
            all_i
        }
    };
    let (mut nth, mut found, want) = (0, Value::Null, s.window);
    for &i in &order {
        s.window = all[i]["window_id"].as_u64().unwrap_or(0);
        (nth, found) = (
            i + 1,
            call(data, "get_window_state", state_args(s, me), here)?,
        );
        // The session's window, just opened, reaches accessibility a moment after the list.
        let start = Instant::now();
        while unresolved(&found) && s.window == want && start.elapsed() < THIN_WAIT / 2 {
            thread::sleep(Duration::from_millis(250));
            found = call(data, "get_window_state", state_args(s, me), here)?;
        }
        if !unresolved(&found) {
            break;
        }
    }
    // A window just closed lingers in the list a moment: none left means the app has none.
    if unresolved(&found) && asked.is_none() && {
        thread::sleep(Duration::from_millis(500));
        windows(data, s.pid, here)?.is_empty()
    } {
        (s.window, s.snapshot, s.secure, s.frames) = Default::default();
        return menu_bar(data, s, here);
    }
    let window = &all[nth - 1];
    if thin(&found) && lock(&ASKED).insert(s.pid) {
        chromium(data, s.pid, here);
        let start = Instant::now();
        let mut last = 0;
        while start.elapsed() < THIN_WAIT {
            thread::sleep(Duration::from_millis(500));
            found = call(data, "get_window_state", state_args(s, me), here)?;
            let n = found["total_element_count"].as_u64().unwrap_or(0);
            if !thin(&found) && n == last {
                break;
            }
            last = n;
        }
    }
    (s.secure, s.frames, s.moved) = Default::default();
    learn(s, &found);
    let tree = found["tree_markdown"].as_str().unwrap_or("");
    // The window's own title, as accessibility gives it: the listed one is often empty.
    let named = (tree.split("AXWindow \"").nth(1)).and_then(|t| t.split('"').next());
    let title = (window["title"].as_str())
        .filter(|t| !t.is_empty())
        .or(named)
        .unwrap_or("untitled");
    let total = found["total_element_count"].as_u64().unwrap_or(0);
    let mut text = format!(
        "{} · \"{title}\" · window {nth} of {} · {total} elements\n{}",
        s.app,
        all.len(),
        tidy(&mask(tree, &s.secure))
    );
    if found["truncated"] == true {
        text.push_str(&format!(
            "\n(Cut at {} rows: --query WORDS for one part, or --full for more.)",
            state_args(s, me)["max_elements"]
        ));
    }
    if thin(&found) {
        text.push_str(&format!("\n{}'s window shows little to accessibility yet: read again in a few seconds, or `brigadier computer screenshot` to look at it.", s.app));
    }
    Ok(text)
}

fn unresolved(found: &Value) -> bool {
    (found["degraded_reason"].as_str()).is_some_and(|r| r.starts_with("ax_window_unresolved"))
}

fn thin(found: &Value) -> bool {
    unresolved(found) || found["total_element_count"].as_u64().unwrap_or(0) < THIN
}

/// Rows without the driver's action lists, which Chromium fills with its own menus.
pub(super) fn tidy(md: &str) -> String {
    let mut out = String::with_capacity(md.len());
    let mut rest = md;
    while let Some(at) = rest.find("actions=[") {
        out.push_str(rest[..at].trim_end_matches(' '));
        let after = &rest[at + "actions=[".len()..];
        rest = after.find(']').map_or("", |end| &after[end + 1..]);
    }
    out.push_str(rest);
    ours(&out.replace(" []", ""))
}

pub(super) const NO_CHANGE: &str = "No change in the window.";

/// Whether row [n] of a read or a diff shows `text` (its first line, as far as a row shows it).
pub(super) fn shows(md: &str, n: u64, text: &str) -> bool {
    let want: String = text
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .chars()
        .take(30)
        .collect();
    md.lines().any(|l| row(l) == Some(n) && l.contains(&want))
}

/// What changed in the window since the last read, from Cua's own `since` read.
pub(super) fn changes(data: &Path, me: &str, s: &mut Sess, here: &dyn Fn() -> bool) -> String {
    let mut args = state_args(s, me);
    args["since"] = "latest".into();
    let Ok(found) = call(data, "get_window_state", args, here) else {
        // The window went (a panel closed, a document replaced it): read what the app shows now.
        let again = Words {
            verb: "read",
            rest: vec![],
            values: Default::default(),
            flags: Default::default(),
        };
        return match read(data, me, s, &again, here) {
            Ok(text) => format!("The window changed:\n{text}"),
            Err(_) => format!(
                "Couldn't read {} after it: `brigadier computer read {}`.",
                s.app, s.app
            ),
        };
    };
    learn(s, &found);
    match found["since_status"].as_str() {
        Some("no_change") => NO_CHANGE.into(),
        Some("diff") => {
            let diff = found["tree_diff"].as_str().unwrap_or("");
            s.moved |= diff.contains("\nreindexed:");
            let body: Vec<&str> = diff.lines().skip(1).collect();
            let moved = if s.moved {
                "\nThe numbers moved: read again before using them."
            } else {
                ""
            };
            format!(
                "Changed:\n{}{moved}",
                tidy(&mask(&body.join("\n"), &s.secure))
            )
        }
        _ => {
            (s.secure, s.moved) = Default::default();
            learn(s, &found);
            format!(
                "The window changed:\n{}",
                tidy(&mask(
                    found["tree_markdown"].as_str().unwrap_or(""),
                    &s.secure
                ))
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
    region: Option<&str>,
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
    let shot = json!({"pid": s.pid, "window_id": s.window, "session": me, "include_accessibility_tree": false, "include_screenshot": true, "screenshot_out_file": file, "screenshot_format": "jpeg", "max_dimension": 1280});
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
    let Some(r) = region else {
        return Ok(format!(
            "Saved: {}{size}. `click --at X,Y` clicks a point of it.",
            file.display()
        ));
    };
    // A part of the picture, cut in place (proposed).
    let n: Vec<u64> = (r.split(','))
        .filter_map(|v| v.trim().parse().ok())
        .collect();
    let [x, y, w, h] = n[..] else {
        return Err(refuse(
            "--region takes X,Y,W,H in the picture's pixels: --region 0,0,640,400",
        ));
    };
    let cut = std::process::Command::new("sips")
        .args(["--cropToHeightWidth", &h.to_string(), &w.to_string()])
        .args(["--cropOffset", &y.to_string(), &x.to_string()])
        .arg(&file)
        .output();
    if !cut.is_ok_and(|o| o.status.success()) {
        return Err(refuse(
            "Couldn't cut that region: check it lies inside the picture.",
        ));
    }
    Ok(format!(
        "Saved: {} ({w}×{h}), the part at {x},{y} of the window's picture{size}. `click --at X,Y` takes the whole picture's pixels: add {x},{y}.",
        file.display()
    ))
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

/// The driver's words for its own tools, said as this command's: an agent can't call those.
pub(super) fn ours(text: &str) -> String {
    [
        ("take a fresh get_window_state snapshot and re-address it", "read again"),
        ("(menus collapsed: run an item with invoke_menu path, or pass query to search menu items)", "(menus: `menu \"File > …\"` picks an item, --query WORDS finds one)"),
        ("retry with a larger max_elements or narrow with query / max_depth", "read with --full, or narrow it with --query WORDS"),
        ("the max_elements node budget", "the row budget"),
        ("get_window_state", "read"),
        ("element_token", "number"),
        ("invoke_menu", "menu"),
        ("bring_to_front", "the user bringing it forward"),
        ("delivery_mode:\"foreground\"", "the app in front"),
    ]
    .iter()
    .fold(text.to_string(), |t, (a, b)| t.replace(a, b))
}
