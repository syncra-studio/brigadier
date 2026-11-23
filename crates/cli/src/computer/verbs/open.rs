//! Opening an app and finding its windows, so the agent never meets a dead end [D922 D928]: an
//! app with no window shows its menu bar, and its menus and key equivalents work by pid, through
//! the helper's own calls (Cua's need a window, #8055).

use super::act::{CLICK, MODIFIER, act, idle, wait_for_user};
use super::window::{Seen, baseline, changes, read};
use super::{Fail, SESSIONS, Sess, Words, blocked, call, lock, refuse, said};
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
    // What the user has in front, to keep there [D909].
    let user = front(data, here);
    let user_window = match user {
        Some(pid) => windows(data, pid, here)?
            .first()
            .map(|w| w["window_id"].clone()),
        None => None,
    };
    // Through LaunchServices in the background, a cold start too: Cua's launch_app brought a cold
    // Calculator to the front, and macOS left the user's full-screen Space for it; `open -g`
    // didn't (D946). Cua's handoff timed out on a Finder folder and took 8 s to give Dia a url.
    let installed = call(data, "list_apps", json!({}), here)?;
    let listed = named(installed["apps"].as_array().map_or(&[][..], |a| a), &name);
    let bundle = listed.and_then(|a| a["bundle_id"].as_str()).unwrap_or("");
    blocked(&name, bundle)?;
    let titled = |pid: i64| -> Vec<(Value, Value)> {
        (windows(data, pid, here).unwrap_or_default().iter())
            .map(|w| (w["window_id"].clone(), w["title"].clone()))
            .collect()
    };
    // A running app's windows as they were, to find the one the url or path lands in: Chrome
    // puts a url in its last normal window, not a popup in front of it [D2032].
    let was = listed
        .filter(|a| a["running"] == true)
        .and_then(|a| a["pid"].as_i64());
    let before = was.map(titled).unwrap_or_default();
    let mut launch = std::process::Command::new("open");
    let app_path = listed.and_then(|a| a["launch_path"].as_str());
    launch.args(["-g", "-a", app_path.unwrap_or(&name)]);
    launch.args(&target);
    if listed.is_none_or(|a| a["running"] == false) {
        launch.arg("--args").args(windowed(bundle));
    }
    let sent = launch.output();
    if !sent.as_ref().is_ok_and(|o| o.status.success()) {
        let why = sent.map(|o| {
            String::from_utf8_lossy(&o.stderr)
                .trim()
                .trim_end_matches('.')
                .to_string()
        });
        let with = target.as_ref().map(|t| format!(" {t}")).unwrap_or_default();
        return Err(refuse(&format!(
            "{name} couldn't open{with}: {}. `brigadier computer apps` lists what runs.",
            why.unwrap_or_else(|e| e.to_string())
        )));
    }
    // A cold start can take a moment to show up as running.
    let launched = Instant::now();
    let (pid, app) = loop {
        match find(data, &name, here) {
            Err(_) if launched.elapsed() < WINDOW_WAIT => thread::sleep(Duration::from_millis(250)),
            found => break found?,
        }
    };
    let window = match s.pid == pid {
        true => s.window,
        false => 0,
    };
    *s = Sess {
        pid,
        app,
        window,
        ..Sess::default()
    };
    let start = Instant::now();
    while target.is_some() && !before.is_empty() && start.elapsed() < WINDOW_WAIT {
        if let Some((id, _)) = titled(pid).into_iter().find(|w| !before.contains(w)) {
            s.window = id.as_u64().unwrap_or(0);
            break;
        }
        thread::sleep(Duration::from_millis(300));
    }
    // The watch, where there is one, tells what finally happened.
    let watch = user.zip(user_window).filter(|(user, _)| *user != pid);
    if let Some((user, window)) = watch.clone() {
        keep_behind(data, me, s.app.clone(), pid, user, window);
    }
    // A window can come a moment after the launch.
    let start = Instant::now();
    while windows(data, s.pid, here)?.is_empty() && start.elapsed() < WINDOW_WAIT {
        thread::sleep(Duration::from_millis(250));
    }
    if watch.is_none() && front(data, here) == Some(pid) {
        let note = format!(
            "{} took the front as it started and stayed there: tell the user.",
            s.app
        );
        lock(&SEEN).entry(me.to_string()).or_default().push(note);
    }
    let what = (target.as_ref())
        .map(|t| format!(" with {t}"))
        .unwrap_or_default();
    let mut body = read(data, me, s, w, here)?;
    // A page loads after its window shows: wait for its web area to take the page's title.
    while target.as_ref().is_some_and(|t| t.contains("://"))
        && !["AXWebArea \"", "AXWebArea ("]
            .iter()
            .any(|named| body.contains(named))
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
/// unless the user clicked or let go of ⌘-Tab as it came forward (they switched to it): typing or
/// clicking in their own app before then doesn't count (D930). One failed put-back ends the watch.
/// What happened is told, as measured.
fn keep_behind(data: &Path, me: &str, app: String, pid: i64, user: i64, window: Value) {
    let (data, me) = (data.to_path_buf(), me.to_string());
    let start = Instant::now();
    thread::spawn(move || {
        let never = || true;
        // When it was last seen behind.
        let mut behind = 0.0;
        while start.elapsed() < KEEP {
            thread::sleep(Duration::from_millis(100));
            let at = start.elapsed().as_secs_f64();
            if front(&data, &never) != Some(pid) {
                behind = at;
                continue;
            }
            if idle(CLICK).min(idle(MODIFIER)) < at - behind {
                return;
            }
            let back = own(
                &data,
                "restore",
                json!({"pid": user, "window": window}),
                &never,
            );
            let restored = back.is_ok_and(|b| b["restored"] == true);
            let note = match restored {
                true => format!(
                    "{app} came to the front by itself after {at:.1} s and was put back behind your app."
                ),
                false => format!(
                    "{app} came to the front by itself after {at:.1} s and couldn't be put back: tell the user."
                ),
            };
            lock(&SEEN).entry(me.clone()).or_default().push(note);
            if !restored {
                return;
            }
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
    if s.window != 0 && !s.batch {
        baseline(data, s, here);
    }
    let id = |w: &Value| w["window_id"].as_u64().unwrap_or(0);
    let listed = windows(data, s.pid, here)?;
    let before: Vec<u64> = listed.iter().map(id).collect();
    // A menu is pressed by pid, past Cua [D928]: its cursor glides to the window's title bar, in
    // screen points, which moves only the cursor [D956].
    if let Some(b) = listed
        .iter()
        .find(|w| id(w) == s.window)
        .map(|w| &w["bounds"])
    {
        let x = b["x"].as_f64().unwrap_or(0.0) + b["width"].as_f64().unwrap_or(0.0) / 2.0;
        let y = b["y"].as_f64().unwrap_or(0.0) + 14.0;
        let _ = call(
            data,
            "move_cursor",
            json!({"x": x, "y": y, "session": me}),
            here,
        );
        if !here() {
            return Err(refuse("Stopped."));
        }
    }
    what["pid"] = s.pid.into();
    what["no_paste"] = (!s.secure.is_empty()).into();
    let read_again = format!("`brigadier computer read {}` shows its menus.", s.app);
    let chose = match crate::computer::own(data, "menu", what, &|| !here()) {
        Err(Fail::Unknown) if s.batch => {
            return Err(refuse(
                "Sent, but no answer came in time: the outcome is unknown.",
            ));
        }
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
        // Refused, so no second try through Cua's menu [D903].
        Ok(Err(why)) if why.ends_with("no pasting: ask the user.") => return Err(refuse(&why)),
        Ok(Err(_)) if !cua.0.is_empty() && s.window != 0 && !s.snapshot.is_empty() => {
            let line = format!("Chose {}", w.rest.join(" "));
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
        let opened = now.iter().find(|w| !before.contains(w)).copied();
        let closed = s.window != 0 && !now.contains(&s.window);
        if opened.is_some() || closed {
            let gone = !running(data, here)?.iter().any(|a| a["pid"] == s.pid);
            if gone {
                *s = Sess::default();
                return Ok(format!("Chose {chose}: done, the app quit."));
            }
            let what = match opened {
                Some(_) => "a window opened",
                None => "its window closed",
            };
            // The new window is read, else the app's first.
            s.window = opened.unwrap_or(0);
            // A run stops here: its next numbers belong to the window read before.
            if s.batch {
                s.snapshot.clear();
                lock(&SESSIONS).insert(me.to_string(), s.clone());
                return Err(refuse(&format!(
                    "Chose {chose}: {what}. Read it before going on."
                )));
            }
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
    if s.batch {
        return Ok(format!("Chose {chose}: sent."));
    }
    if before.is_empty() {
        return Ok(format!(
            "Chose {chose}: no window opened. `brigadier computer read {}` shows where it stands.",
            s.app
        ));
    }
    match changes(data, me, s, here) {
        (Seen::No, _) => Ok(format!(
            "Chose {chose}: no change seen in the window. Read again, or try another way."
        )),
        (Seen::Unsure, diff) => Ok(format!(
            "Chose {chose}: I can't tell what it changed.\n{diff}"
        )),
        (Seen::Yes, diff) => Ok(format!("Chose {chose}: change observed.\n{diff}")),
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
    let app = named(&all, name).ok_or_else(|| refuse(&format!("No running app is named {name}. `brigadier computer apps` lists them; `open` starts one.")))?;
    let found = app["name"].as_str().unwrap_or(name).to_string();
    blocked(&found, app["bundle_id"].as_str().unwrap_or(""))?;
    Ok((app["pid"].as_i64().unwrap_or(0), found))
}

/// An app by its name in `list_apps`: exact first, else the one it starts.
fn named<'a>(all: &'a [Value], name: &str) -> Option<&'a Value> {
    let lower = name.to_lowercase();
    let of = |a: &&Value| a["name"].as_str().unwrap_or("").to_lowercase();
    (all.iter().find(|a| of(a) == lower)).or_else(|| all.iter().find(|a| of(a).starts_with(&lower)))
}

/// Launch arguments that start an app's saved windows out of full screen, for this launch only
/// (D946): an app that keeps its windows in its own settings (Dia's `persistedWindowData`) brings a
/// full-screen one back on a new Space, and macOS goes there whatever `open -g` says. The value is
/// handed back with `"isFullScreen":false`; nothing is written.
fn windowed(bundle: &str) -> Vec<String> {
    let read = |key: &[&str]| {
        let out = std::process::Command::new("defaults")
            .arg("read")
            .arg(bundle)
            .args(key)
            .output()
            .ok()
            .filter(|o| o.status.success())?;
        Some(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    };
    if bundle.is_empty() {
        return vec![];
    }
    // `defaults read` writes each setting as `key = "value";`, the value's quotes escaped.
    let all = read(&[]).unwrap_or_default();
    (all.lines())
        .filter(|l| l.contains(r#"\"isFullScreen\":true"#))
        .filter_map(|l| l.trim().split_once(" = "))
        .filter_map(|(key, _)| {
            let key = key.trim_matches('"');
            let value = read(&[key])?.replace(r#""isFullScreen":true"#, r#""isFullScreen":false"#);
            // Quoted, or the argument domain reads the JSON as a broken plist and drops it.
            let quoted = value.replace('\\', r"\\").replace('"', r#"\""#);
            Some([format!("-{key}"), format!("\"{quoted}\"")])
        })
        .flatten()
        .collect()
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
