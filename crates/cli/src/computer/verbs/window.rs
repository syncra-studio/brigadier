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
        match e["value"].as_str() {
            Some(v) => drop(s.values.insert(n, v.to_string())),
            None => drop(s.values.remove(&n)),
        }
        match (e["role"].as_str(), e["label"].as_str()) {
            (Some("AXMenuItem"), Some(name)) => drop(s.items.insert(n, name.to_string())),
            _ => drop(s.items.remove(&n)),
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

/// Always the whole window: a --query is ours to filter, so the driver's last snapshot, which an
/// action's diff starts from, never holds only part of it [D2032]. A query reads the larger budget.
pub(super) fn state_args(s: &Sess, me: &str) -> Value {
    let (rows, depth) = if s.full || s.query.is_some() {
        FULL
    } else {
        ROWS
    };
    json!({"pid": s.pid, "window_id": s.window, "session": me, "tree_format": "both", "include_screenshot": false, "max_elements": rows, "max_depth": depth})
}

/// The rows holding any of `query`'s `a|b` words, each under its ancestors, as Cua's own
/// `filter_tree` (MIT) gives them.
fn filter(md: &str, query: &str) -> String {
    let words: Vec<String> = (query.to_lowercase().split('|'))
        .map(|w| w.trim().to_string())
        .filter(|w| !w.is_empty())
        .collect();
    let (mut ancestors, mut shown, mut out): (Vec<&str>, Vec<Option<&str>>, Vec<&str>) =
        Default::default();
    for line in md.lines() {
        let depth = line.chars().take_while(|c| *c == ' ').count() / 2;
        while ancestors.len() <= depth {
            ancestors.push("");
            shown.push(None);
        }
        shown[depth + 1..].fill(None);
        ancestors[depth] = line;
        let low = line.to_lowercase();
        if words.iter().any(|w| low.contains(w.as_str())) {
            for d in 0..depth {
                if !ancestors[d].is_empty() && shown[d] != Some(ancestors[d]) {
                    shown[d] = Some(ancestors[d]);
                    out.push(ancestors[d]);
                }
            }
            shown[depth] = Some(line);
            out.push(line);
        }
    }
    out.join("\n")
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
    (s.secure, s.frames, s.values, s.moved) = Default::default();
    learn(s, &found);
    let tree = found["tree_markdown"].as_str().unwrap_or("");
    // The window's own title, as accessibility gives it: the listed one is often empty.
    let named = (tree.split("AXWindow \"").nth(1)).and_then(|t| t.split('"').next());
    let title = (window["title"].as_str())
        .filter(|t| !t.is_empty())
        .or(named)
        .unwrap_or("untitled");
    let total = found["total_element_count"].as_u64().unwrap_or(0);
    let shown = match &s.query {
        Some(q) => match filter(tree, q) {
            rows if rows.is_empty() => format!(
                "No row holds \"{q}\": try a shorter or another word (\"a|b\" finds either), or read without --query."
            ),
            rows => rows,
        },
        None => tree.to_string(),
    };
    let mut text = format!(
        "{} · \"{title}\" · window {nth} of {} · {total} elements\n{}",
        s.app,
        all.len(),
        tidy(&mask(&shown, &s.secure))
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

/// Rows without the driver's action lists, which Chromium fills with its own menus. A window's
/// own text stays as it is: only the driver's words are said as ours, a row's after its list.
pub(super) fn tidy(md: &str) -> String {
    let tidy_row = |line: &str| -> String {
        if !line.trim_start().starts_with(['-', '+', '~']) {
            return ours(line);
        }
        // The list is the row's last bracket, after its name and value.
        let Some(at) = line.rfind("actions=[") else {
            return line.to_string();
        };
        let before = line[..at].trim_end_matches(' ');
        let after = &line[at + "actions=[".len()..];
        let after = after.find(']').map_or("", |end| &after[end + 1..]);
        // `[actions=[…]]` alone leaves `[]`: gone with its space.
        let (before, after) = match (before.strip_suffix('['), after.strip_prefix(']')) {
            (Some(b), Some(a)) => (b.trim_end_matches(' '), a),
            _ => (before, after),
        };
        format!("{before}{}", ours(after))
    };
    md.lines().map(tidy_row).collect::<Vec<_>>().join("\n")
}

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

/// Whether control [n]'s whole value, as last read, holds all of `text` (its ends' spaces aside).
pub(super) fn shows(s: &Sess, n: u64, text: &str) -> bool {
    s.values.get(&n).is_some_and(|v| v.contains(text.trim()))
}

/// The app's windows just before an action, so one it opens or closes is a change too. The
/// window's own rows are diffed against the last read: a new read would void its numbers.
pub(super) fn baseline(data: &Path, s: &mut Sess, here: &dyn Fn() -> bool) {
    s.wins = titles(data, s, here);
}

fn titles(data: &Path, s: &Sess, here: &dyn Fn() -> bool) -> Vec<(u64, String)> {
    let all = windows(data, s.pid, here).unwrap_or_default();
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
        .map(|w| format!("+ window {}", name(&w.1)))
        .collect();
    wins.extend(
        (s.wins.iter())
            .filter(|b| !now.iter().any(|w| w.0 == b.0))
            .map(|b| format!("- window {}", name(&b.1))),
    );
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
            (s.secure, s.values, s.moved) = Default::default();
            learn(s, &found);
            let tree = tidy(&mask(found["tree_markdown"].as_str().unwrap_or(""), &s.secure));
            (Seen::Yes, format!("Most of the window changed; it reads now:\n{tree}"))
        }
        // No baseline to compare: the window as it is now, never called a change.
        _ => {
            (s.secure, s.values, s.moved) = Default::default();
            learn(s, &found);
            let tree = tidy(&mask(found["tree_markdown"].as_str().unwrap_or(""), &s.secure));
            match tree.trim().is_empty() {
                true => (Seen::Unsure, "I couldn't compare it with before, and the window reads empty now: read again.".into()),
                false => (Seen::Unsure, format!("I couldn't compare it with before; the window now:\n{tree}")),
            }
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
    s: &mut Sess,
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
    let full = (
        found["screenshot_width"].as_u64(),
        found["screenshot_height"].as_u64(),
    );
    let size = match full {
        (Some(w), Some(h)) => format!(" ({w}×{h})"),
        _ => String::new(),
    };
    let fresh = fresh(data, s, &file, here);
    let Some(r) = region else {
        return Ok(format!(
            "Saved: {}{size}. `click --at X,Y` clicks a point of it.{fresh}",
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
    // sips pads past an edge with black and still succeeds [D930].
    let out = |at: u64, len: u64, of: Option<u64>| {
        len == 0 || of.is_some_and(|of| at.saturating_add(len) > of)
    };
    if out(x, w, full.0) || out(y, h, full.1) {
        return Err(refuse(&format!(
            "Couldn't cut that region: it must lie inside the picture{size}."
        )));
    }
    let sips = |args: &str| {
        let cut = std::process::Command::new("sips")
            .args(args.split(' '))
            .arg(&file)
            .output();
        cut.is_ok_and(|o| o.status.success())
    };
    let crop = |y: u64, x: u64| format!("--cropToHeightWidth {h} {w} --cropOffset {y} {x}");
    // sips reads a `0 0` offset as none and cuts the centre, and `0.0` as -1 [D930, D936]: the
    // top-left corner is cut as the bottom-right one of the picture turned round.
    let cut = match (x, y, full) {
        (0, 0, (Some(fw), Some(fh))) if (fw, fh) == (w, h) => true,
        (0, 0, (Some(fw), Some(fh))) => {
            sips(&format!("-r 180 {}", crop(fh - h, fw - w))) && sips("-r 180")
        }
        (0, 0, _) => false,
        _ => sips(&crop(y, x)),
    };
    if !cut {
        return Err(refuse("Couldn't cut that region."));
    }
    Ok(format!(
        "Saved: {} ({w}×{h}), the part at {x},{y} of the window's picture{size}. `click --at X,Y` takes the whole picture's pixels: add {x},{y}.{fresh}",
        file.display()
    ))
}

/// Whether a picture can be trusted: its hash against the last one's, and whether the window was
/// on show. A covered or off-Space window keeps its last frame, or none: Chromium stops painting
/// a covered window, so its web area comes back stale or blank while the tree is current [D2032].
fn fresh(data: &Path, s: &mut Sess, file: &Path, here: &dyn Fn() -> bool) -> String {
    use sha2::{Digest, Sha256};
    let hash: String = fs::read(file).map_or_else(
        |_| "unknown".into(),
        |b| {
            Sha256::digest(&b)[..6]
                .iter()
                .map(|x| format!("{x:02x}"))
                .collect()
        },
    );
    let same = s
        .shot
        .as_ref()
        .is_some_and(|(w, h)| *w == s.window && *h == hash);
    let changed = std::mem::take(&mut s.changed);
    s.shot = Some((s.window, hash.clone()));
    let mut out = format!(" Hash {hash}.");
    if same {
        out.push_str(match changed {
            true => " Same picture as your last screenshot, though the window changed since: it's stale. Trust your read, not this picture.",
            false => " Same picture as your last screenshot.",
        });
    }
    if let Some(why) = hidden(data, s, here) {
        out.push_str(&format!(" {why}: an app such as Chrome stops painting a window then, so this picture may be stale or blank. Your read is current."));
    }
    out
}

/// The window is off this Space, or wholly under one window of another app.
// shortcut: one window must cover it alone; two side by side that cover it together aren't seen.
fn hidden(data: &Path, s: &Sess, here: &dyn Fn() -> bool) -> Option<String> {
    let all = call(data, "list_windows", json!({"on_screen_only": false}), here).ok()?;
    let all = all["windows"].as_array()?;
    let mine = all
        .iter()
        .find(|w| w["window_id"].as_u64() == Some(s.window))?;
    if mine["on_current_space"] == false || mine["is_on_screen"] == false {
        return Some(format!(
            "{}'s window isn't on the screen the user sees",
            s.app
        ));
    }
    let rect = |w: &Value| {
        let b = &w["bounds"];
        let n = |k: &str| b[k].as_f64().unwrap_or(0.0);
        (n("x"), n("y"), n("x") + n("width"), n("y") + n("height"))
    };
    let (z, (x0, y0, x1, y1)) = (mine["z_index"].as_i64()?, rect(mine));
    let over = all.iter().find(|w| {
        let (a0, b0, a1, b1) = rect(w);
        w["pid"] != mine["pid"]
            // The driver's own see-through overlay, where it draws the agent cursor.
            && w["app_name"] != "cua-driver"
            && w["layer"].as_i64() == Some(0)
            && w["is_on_screen"] != false
            && w["z_index"].as_i64().is_some_and(|wz| wz > z)
            && a0 <= x0
            && b0 <= y0
            && a1 >= x1
            && b1 >= y1
    })?;
    let by = over["app_name"].as_str().unwrap_or("another app");
    Some(format!("{}'s window is covered by {by}'s", s.app))
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
