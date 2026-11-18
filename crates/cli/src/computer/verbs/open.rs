//! Opening an app and finding its windows, so the agent never meets a dead end [D922 D928]: an
//! app with no window shows its menu bar, and its menus and key equivalents work by pid, through
//! the helper's own calls (Cua's need a window, #8055).

use super::act::{act, idle, wait_for_user};
use super::window::{NO_CHANGE, changes, read};
use super::{Fail, Sess, Words, blocked, call, lock, refuse, said};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// How long `open`, or a menu item, may take to show a window.
const WINDOW_WAIT: Duration = Duration::from_secs(3);
/// How long `open` with a url waits for the page to show content.
const PAGE_WAIT: Duration = Duration::from_secs(6);

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
    // What the user has in front, to keep there [D909].
    let user = front(data, here);
    let user_window = match user {
        Some(pid) => windows(data, pid, here)?
            .first()
            .map(|w| w["window_id"].clone()),
        None => None,
    };
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
    // Cua demotes an app that takes the front at launch, and says if it stayed.
    if opened["self_activation_suppressed"] == false {
        let note = format!(
            "{} took the front as it started and stayed there: tell the user.",
            s.app
        );
        lock(&SEEN).entry(me.to_string()).or_default().push(note);
    }
    if let (Some(user), Some(window)) = (user, user_window)
        && user != pid
    {
        keep_behind(data, me, s.app.clone(), pid, user, window);
    }
    // A window can come a moment after the launch.
    let start = Instant::now();
    while windows(data, s.pid, here)?.is_empty() && start.elapsed() < WINDOW_WAIT {
        thread::sleep(Duration::from_millis(250));
    }
    let what = (target.as_ref())
        .map(|t| format!(" with {t}"))
        .unwrap_or_default();
    let mut body = read(data, me, s, w, here)?;
    // A page loads after its window shows: wait for its content.
    while target.as_ref().is_some_and(|t| t.contains("://"))
        && !body.contains("AXWebArea")
        && start.elapsed() < PAGE_WAIT
    {
        thread::sleep(Duration::from_millis(400));
        body = read(data, me, s, w, here)?;
    }
    let how = match notes(me) {
        n if n.is_empty() => " in the background.".to_string(),
        n => format!(". {n}"),
    };
    Ok(format!("Opened {}{what}{how}\n{body}", s.app))
}

/// How long a launched app is watched: Chromium activates itself each time it shows a window,
/// later than Cua's 0.5 s guard on a plain launch; the old app's fork kept apps behind ~10 s.
const KEEP: Duration = Duration::from_secs(10);
/// What the watch saw, by session, said with that session's next reply.
static SEEN: LazyLock<Mutex<HashMap<String, Vec<String>>>> = LazyLock::new(Mutex::default);

/// The pid WindowServer has in front now; `list_apps`' `active` lags.
pub(super) fn front(data: &Path, here: &dyn Fn() -> bool) -> Option<i64> {
    own(data, "front", json!({}), here).ok()?["pid"].as_i64()
}

/// For 10 s after a launch, an app that takes the front is put back behind the user's window,
/// unless the user gave input since (they may have switched to it). What happened is told, as
/// measured.
fn keep_behind(data: &Path, me: &str, app: String, pid: i64, user: i64, window: Value) {
    let (data, me) = (data.to_path_buf(), me.to_string());
    let start = Instant::now();
    thread::spawn(move || {
        let never = || true;
        while start.elapsed() < KEEP {
            thread::sleep(Duration::from_millis(100));
            if front(&data, &never) != Some(pid) {
                continue;
            }
            let at = start.elapsed().as_secs_f64();
            if idle() < at {
                return;
            }
            let back = own(
                &data,
                "restore",
                json!({"pid": user, "window": window}),
                &never,
            );
            let note = match back.is_ok_and(|b| b["restored"] == true) {
                true => format!(
                    "{app} came to the front by itself after {at:.1} s and was put back behind your app."
                ),
                false => format!(
                    "{app} came to the front by itself after {at:.1} s and couldn't be put back: tell the user."
                ),
            };
            lock(&SEEN).entry(me.clone()).or_default().push(note);
        }
    });
}

/// What the watch saw for `me` since it last said.
pub(super) fn notes(me: &str) -> String {
    let mut seen = lock(&SEEN).remove(me).unwrap_or_default();
    seen.dedup();
    seen.join(" ")
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
        // Greyed is greyed for the driver too.
        Ok(Err(why)) if why.ends_with("greyed out now.") => {
            return Err(refuse(&format!(
                "{why} An app greys some items while it's behind the user's window or nothing is selected: use the same control in the window (`brigadier computer read {}`), or ask the user.",
                s.app
            )));
        }
        Ok(Err(_)) if !cua.0.is_empty() && s.window != 0 && !s.snapshot.is_empty() => {
            let line = match cua.0 {
                "hotkey" => format!("Pressed {}", w.rest.join(" ")),
                _ => format!("Chose {}", w.rest.join(" ")),
            };
            return act(data, me, s, &line, cua.0, cua.1, here);
        }
        Ok(Err(why)) => return Err(refuse(&format!("{why} {read_again}"))),
        Ok(Ok(done)) => done["pressed"].as_str().unwrap_or("the item").to_string(),
    };
    if s.batch {
        return Ok(format!("Chose {chose}: sent."));
    }
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
            let gone = closed && !running(data, here)?.iter().any(|a| a["pid"] == s.pid);
            if gone {
                *s = Sess::default();
                return Ok(format!("Chose {chose}: done, the app quit."));
            }
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
    match changes(data, me, s, here) {
        diff if diff == NO_CHANGE => Ok(format!(
            "Chose {chose}: no change seen in the window. Read again, or try another way."
        )),
        diff => Ok(format!("Chose {chose}: change observed.\n{diff}")),
    }
}

pub(super) fn running(data: &Path, here: &dyn Fn() -> bool) -> Result<Vec<Value>, Value> {
    let found = call(data, "list_apps", json!({}), here)?;
    Ok((found["apps"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter())
    .filter(|a| a["running"] != false)
    .collect())
}

pub(super) fn apps(data: &Path, here: &dyn Fn() -> bool) -> Result<String, Value> {
    let front = front(data, here);
    let lines: Vec<String> = (running(data, here)?.iter())
        .filter(|a| {
            blocked(
                a["name"].as_str().unwrap_or(""),
                a["bundle_id"].as_str().unwrap_or(""),
            )
            .is_ok()
        })
        .map(|a| {
            format!(
                "{}{}",
                a["name"].as_str().unwrap_or("?"),
                if a["pid"].as_i64() == front {
                    " (front)"
                } else {
                    ""
                }
            )
        })
        .collect();
    Ok(format!("Running apps:\n{}", lines.join("\n")))
}

/// A running app by its name: exact first, else the one it starts.
pub(super) fn find(
    data: &Path,
    name: &str,
    here: &dyn Fn() -> bool,
) -> Result<(i64, String), Value> {
    let all = running(data, here)?;
    let named = |a: &&Value| a["name"].as_str().unwrap_or("").to_lowercase();
    let lower = name.to_lowercase();
    let app = (all.iter().find(|a| named(a) == lower))
        .or_else(|| all.iter().find(|a| named(a).starts_with(&lower)))
        .ok_or_else(|| refuse(&format!("No running app is named {name}. `brigadier computer apps` lists them; `open` starts one.")))?;
    let found = app["name"].as_str().unwrap_or(name).to_string();
    blocked(&found, app["bundle_id"].as_str().unwrap_or(""))?;
    Ok((app["pid"].as_i64().unwrap_or(0), found))
}

/// A menu's path from `menu "File > Save As…"`.
pub(super) fn menu_path(w: &Words) -> Result<Vec<String>, Value> {
    let path: Vec<String> = (w.rest.join(" ").split('>'))
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    match path.len() {
        0 => Err(refuse(
            "Give the menu's path: brigadier computer menu \"File > Save As…\"",
        )),
        _ => Ok(path),
    }
}
