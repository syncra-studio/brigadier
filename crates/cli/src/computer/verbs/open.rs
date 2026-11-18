//! Opening an app and finding its windows, so the agent never meets a dead end [D922 D928]: an
//! app with no window shows its menu bar, and its menus and key equivalents work by pid, through
//! the helper's own calls (Cua's need a window, #8055).

use super::act::{act, wait_for_user};
use super::window::{changes, read};
use super::{Fail, Sess, Words, blocked, call, refuse, said};
use serde_json::{Value, json};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

/// How long `open`, or a menu item, may take to show a window.
const WINDOW_WAIT: Duration = Duration::from_secs(3);

/// One of the helper's own calls, answered as a driver call is.
pub(super) fn own(
    data: &Path,
    method: &str,
    params: Value,
    here: &dyn Fn() -> bool,
) -> Result<Value, Value> {
    crate::computer::own(data, method, params, &|| !here())
        .map_err(said)?
        .map_err(|e| refuse(&e))
}

/// `open <app> [url|path]` (the url or path: proposed): starts the app in the background, or hands
/// a running one the url or path, then reads what it shows.
pub(super) fn open(
    data: &Path,
    me: &str,
    s: &mut Sess,
    w: &Words,
    here: &dyn Fn() -> bool,
) -> Result<String, Value> {
    let mut words = w.rest.clone();
    let target = words
        .last()
        .filter(|t| words.len() > 1 && (t.contains("://") || t.starts_with(['/', '~'])))
        .map(|t| match t.strip_prefix('~') {
            Some(rest) => format!("{}{rest}", std::env::var("HOME").unwrap_or_default()),
            None => t.to_string(),
        });
    if target.is_some() {
        words.pop();
    }
    let name = words.join(" ");
    if name.is_empty() {
        return Err(refuse(
            "Name the app: brigadier computer open TextEdit (or open Safari https://example.com).",
        ));
    }
    blocked(&name, "")?;
    let mut args = json!({"name": name});
    if let Some(t) = &target {
        args["urls"] = json!([t]);
    }
    let opened = call(data, "launch_app", args, here)?;
    let pid = opened["pid"].as_i64().ok_or_else(|| {
        refuse(&format!(
            "{name} didn't start. `brigadier computer apps` lists what runs."
        ))
    })?;
    blocked(&name, opened["bundle_id"].as_str().unwrap_or(""))?;
    *s = Sess {
        pid,
        app: opened["name"].as_str().unwrap_or(&name).to_string(),
        ..Sess::default()
    };
    // A window can come a moment after the launch.
    let start = Instant::now();
    while windows(data, s.pid, here)?.is_empty() && start.elapsed() < WINDOW_WAIT {
        thread::sleep(Duration::from_millis(250));
    }
    let what = target.map(|t| format!(" with {t}")).unwrap_or_default();
    let body = read(data, me, s, w, here)?;
    Ok(format!("Opened {}{what} in the background.\n{body}", s.app))
}

/// The app's windows a person could see, its front one first: on this Space, then on others.
/// Slivers, the zero-size windows apps keep and ordered-out ones are left out.
pub(super) fn windows(data: &Path, pid: i64, here: &dyn Fn() -> bool) -> Result<Vec<Value>, Value> {
    let found = call(data, "list_windows", json!({"pid": pid}), here)?;
    let mut all: Vec<Value> = (found["windows"].as_array().cloned().unwrap_or_default())
        .into_iter()
        .filter(|w| {
            let b = &w["bounds"];
            // Off screen on the Space in view: ordered out (a closed panel apps keep).
            // shortcut: minimized windows go too; list them if an agent ever needs one.
            let hidden = w["on_current_space"] == true && w["is_on_screen"] == false;
            w["layer"].as_i64().unwrap_or(0) == 0
                && !hidden
                && b["width"].as_f64().unwrap_or(0.0) >= 40.0
                && b["height"].as_f64().unwrap_or(0.0) >= 40.0
        })
        .collect();
    all.sort_by_key(|w| {
        (
            w["on_current_space"] == false,
            w["is_on_screen"] == false,
            -w["z_index"].as_i64().unwrap_or(0),
        )
    });
    Ok(all)
}

/// An app with no window: its menus, which work by pid.
pub(super) fn menu_bar(data: &Path, s: &Sess, here: &dyn Fn() -> bool) -> Result<String, Value> {
    let found = own(data, "menus", json!({"pid": s.pid}), here)?;
    let menus: Vec<String> = (found["menus"].as_array().into_iter().flatten())
        .map(|m| {
            let items: Vec<String> = (m["items"].as_array().into_iter().flatten())
                .take(30)
                .map(|i| {
                    let key = i["key"].as_str().unwrap_or("");
                    let title = i["title"].as_str().unwrap_or("");
                    if key.is_empty() {
                        title.to_string()
                    } else {
                        format!("{title} {key}")
                    }
                })
                .collect();
            format!(
                "{}: {}",
                m["title"].as_str().unwrap_or("?"),
                items.join(" · ")
            )
        })
        .collect();
    Ok(format!(
        "{} has no window open. Its menus work without one: brigadier computer menu \"File > New\", or a key such as cmd+n.\n{}",
        s.app,
        menus.join("\n")
    ))
}

/// Presses a menu item by its path or its key equivalent, by pid; where the app has no such item
/// and has a window, `cua` (the driver's own route) runs instead. A window it opens or closes is
/// read; else what changed.
#[allow(clippy::too_many_arguments)]
pub(super) fn press(
    data: &Path,
    me: &str,
    s: &mut Sess,
    mut what: Value,
    cua: (&str, Value),
    w: &Words,
    here: &dyn Fn() -> bool,
) -> Result<String, Value> {
    wait_for_user(data, s, here)?;
    let id = |w: &Value| w["window_id"].as_u64().unwrap_or(0);
    let before: Vec<u64> = windows(data, s.pid, here)?.iter().map(id).collect();
    what["pid"] = s.pid.into();
    let read_again = format!("`brigadier computer read {}` shows its menus.", s.app);
    let chose = match crate::computer::own(data, "menu", what, &|| !here()) {
        Err(Fail::Unknown) => {
            return Ok(format!(
                "Sent, but no answer came in time: the outcome is unknown. {read_again}"
            ));
        }
        Err(f) => return Err(said(f)),
        Ok(Err(_)) if s.window != 0 && !s.snapshot.is_empty() => {
            let line = match cua.0 {
                "hotkey" => format!("Pressed {}", w.rest.join(" ")),
                _ => format!("Chose {}", w.rest.join(" ")),
            };
            return act(data, me, s, &line, cua.0, cua.1, here);
        }
        Ok(Err(why)) => return Err(refuse(&format!("{why} {read_again}"))),
        Ok(Ok(done)) => done["pressed"].as_str().unwrap_or("the item").to_string(),
    };
    let start = Instant::now();
    let wait = match before.is_empty() {
        true => WINDOW_WAIT,
        false => Duration::from_millis(600),
    };
    loop {
        let now: Vec<u64> = windows(data, s.pid, here)?.iter().map(id).collect();
        let opened = now.first().is_some_and(|w| !before.contains(w));
        let closed = s.window != 0 && !now.contains(&s.window);
        if opened || closed {
            let what = if opened {
                "a window opened"
            } else {
                "its window closed"
            };
            s.window = 0;
            return Ok(format!(
                "Chose {chose}: done, {what}.\n{}",
                read(data, me, s, w, here)?
            ));
        }
        if start.elapsed() >= wait {
            break;
        }
        thread::sleep(Duration::from_millis(200));
    }
    if before.is_empty() {
        return Ok(format!(
            "Chose {chose}: no window opened. `brigadier computer read {}` shows where it stands.",
            s.app
        ));
    }
    Ok(format!("Chose {chose}.\n{}", changes(data, me, s, here)))
}
