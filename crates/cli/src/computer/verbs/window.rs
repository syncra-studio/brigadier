//! One window as the agent reads it: its rows with password fields hidden, what changed since the
//! last read (Cua's own `since`), and a picture of it.

use super::apps::{menu_bar, menus};
use super::diff::live;
use super::open::{own, windows};
use super::{FULL, ROWS, SECURE, Sess, Words, call, lock, refuse};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant};

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
            // shortcut: Chromium's and Safari's English names; add others as an agent meets them.
            (Some("AXTextField"), Some(name))
                if name.to_lowercase().starts_with("address and search") =>
            {
                s.address = Some(n);
                drop(s.items.remove(&n))
            }
            _ => drop(s.items.remove(&n)),
        }
        if let Some(f) = e["frame"].as_object() {
            let f = ["x", "y", "w", "h"].map(|k| f.get(k).and_then(Value::as_f64).unwrap_or(0.0));
            if e["role"] == "AXWebArea" {
                s.web = Some(f);
            }
            s.frames.insert(n, f);
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

/// The window's rows less its menu bar's: a search for a page's word met History and Log Out.
fn content(md: &str) -> String {
    let mut bar: Option<usize> = None;
    let rows = md.lines().filter(|line| {
        let depth = line.len() - line.trim_start().len();
        if bar.is_some_and(|d| depth > d) {
            return false;
        }
        bar = (line.contains("] AXMenuBar ") || line.trim_start().starts_with("- AXMenuBar "))
            .then_some(depth);
        bar.is_none()
    });
    rows.collect::<Vec<_>>().join("\n")
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
    let all = live(data, s, here)?;
    if all.is_empty() {
        (s.window, s.snapshot, s.secure, s.frames) = Default::default();
        // A query searches a window's content; the menu bar only when asked, as with a window.
        return match (w.values.get("--query"), w.flags.contains("--menus")) {
            (None, _) => menu_bar(data, s, here),
            (Some(q), true) => Ok(menus(data, s, Some(q), here)?.join("\n")),
            (Some(_), false) => Ok(format!(
                "{} has no window open, so it has no content to search: --menus searches its menu bar.",
                s.app
            )),
        };
    }
    let id = |w: &Value| w["window_id"].as_u64().unwrap_or(0);
    // By the window's own id, which stays while it's open: a position moves as others come and go.
    let asked = match w.values.get("--window") {
        None => None,
        Some(n) => match all.iter().position(|w| n.parse() == Ok(id(w))) {
            Some(i) => Some(i + 1),
            None => {
                let list: Vec<String> = (all.iter())
                    .map(|w| format!("{} \"{}\"", id(w), w["title"].as_str().unwrap_or("")))
                    .collect();
                return Err(refuse(&format!(
                    "{} has no window {n}; its windows by id: {}.",
                    s.app,
                    list.join(", ")
                )));
            }
        },
    };
    (s.query, s.full) = (
        w.values.get("--query").map(|q| q.to_string()),
        w.flags.contains("--full"),
    );
    // Unasked, the window last read or acted on, else the first accessibility knows: list_windows keeps closed ones a while (Cua
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
    (s.secure, s.frames, s.values, s.moved, s.address) = Default::default();
    learn(s, &found);
    let tree = found["tree_markdown"].as_str().unwrap_or("");
    // The window's own title, as accessibility gives it: the listed one is often empty.
    let named = (tree.split("AXWindow \"").nth(1)).and_then(|t| t.split('"').next());
    let title = (window["title"].as_str())
        .filter(|t| !t.is_empty())
        .or(named)
        .unwrap_or("untitled");
    let total = found["total_element_count"].as_u64().unwrap_or(0);
    // The window's content only: the menu bar's items drowned a page's rows [D2032].
    let menus_too = w.flags.contains("--menus");
    let mut shown = match &s.query {
        Some(q) => match filter(
            &if menus_too {
                tree.to_string()
            } else {
                content(tree)
            },
            q,
        ) {
            rows if rows.is_empty() => format!(
                "No row holds \"{q}\": try a shorter or another word (\"a|b\" finds either), --menus to search the menu bar too, or read without --query."
            ),
            rows => rows,
        },
        None => tree.to_string(),
    };
    if menus_too {
        let items = menus(data, s, s.query.as_deref(), here)?;
        shown.push_str(&match items.is_empty() {
            true => "\nNo menu item holds it.".to_string(),
            false => format!("\nThe menu bar:\n{}", items.join("\n")),
        });
    }
    let mut text = format!(
        "{} · \"{title}\" · --window {} ({nth} of {}) · {total} elements\n{}",
        s.app,
        s.window,
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

pub(super) fn unresolved(found: &Value) -> bool {
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

/// Whether control [n]'s whole value, as last read, holds all of `text` (its ends' spaces aside).
pub(super) fn shows(s: &Sess, n: u64, text: &str) -> bool {
    s.values.get(&n).is_some_and(|v| v.contains(text.trim()))
}

/// The driver's words for its own tools, said as this command's: an agent can't call those.
pub(super) fn ours(text: &str) -> String {
    [
        ("take a fresh get_window_state snapshot and re-address it", "read again"),
        ("(menus collapsed: run an item with invoke_menu path, or pass query to search menu items)", "(menus: `menu \"File > …\"` picks an item, --query WORDS --menus finds one)"),
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
