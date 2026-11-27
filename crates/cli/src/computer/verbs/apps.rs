//! The running apps by name, one line each, and an app's menus by path: what an agent names an app
//! or a menu item with [D922 D928].

use super::diff::Control;
use super::open::{front, own, windows};
use super::{Sess, Words, call, refuse};
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// An app with no window: its menus, which work by pid.
pub(super) fn menu_bar(data: &Path, s: &Sess, here: &dyn Fn() -> bool) -> Result<String, Value> {
    Ok(format!(
        "{} has no window open. Its menus work without one: brigadier computer menu \"File > New\".\n{}",
        s.app,
        menus(data, s, None, here)?.join("\n")
    ))
}

/// The app's menus, a line each; with `query`'s `a|b` words, only the items holding one, each as
/// the path `menu` takes.
pub(super) fn menus(
    data: &Path,
    s: &Sess,
    query: Option<&str>,
    here: &dyn Fn() -> bool,
) -> Result<Vec<String>, Value> {
    let found = own(data, "menus", json!({"pid": s.pid}), here)?;
    let all = found["menus"].as_array().into_iter().flatten();
    if let Some(q) = query {
        let words: Vec<String> = (q.to_lowercase().split('|'))
            .map(|w| w.trim().to_string())
            .filter(|w| !w.is_empty())
            .collect();
        let words = &words;
        return Ok(all
            .flat_map(|m| {
                let menu = m["title"].as_str().unwrap_or("?").to_string();
                (m["items"].as_array().into_iter().flatten()).filter_map(move |i| {
                    let title = i["title"].as_str().unwrap_or("");
                    let low = title.to_lowercase();
                    (words.iter().any(|w| low.contains(w.as_str()))).then(|| {
                        format!(
                            "menu \"{menu} > {title}\" {}",
                            i["key"].as_str().unwrap_or("")
                        )
                    })
                })
            })
            .map(|l| l.trim_end().to_string())
            .collect());
    }
    Ok(all
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
        .collect())
}

pub(super) fn running(data: &Path, here: &dyn Fn() -> bool) -> Result<Vec<Value>, Value> {
    let found = call(data, "list_apps", json!({}), here)?;
    let mut all: Vec<Value> = (found["apps"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter())
    .filter(|a| a["running"] != false)
    .collect();
    // Cua lists no app without a bundle id (its read_app_plist needs one): such an app is listed by
    // its name while it has a window, as Cua lists a bundle outside the app folders [C113].
    let windows = call(data, "list_windows", json!({"on_screen_only": false}), here);
    let mut pids: Vec<i64> = (windows.ok().iter())
        .flat_map(|w| w["windows"].as_array().cloned().unwrap_or_default())
        .filter(|w| w["layer"].as_i64() == Some(0))
        .filter_map(|w| w["pid"].as_i64())
        .collect();
    pids.sort_unstable();
    pids.dedup();
    for pid in pids {
        if !all.iter().any(|a| a["pid"] == pid)
            && let Some(name) = unbundled(pid)
        {
            all.push(json!({"name": name, "pid": pid, "running": true}));
        }
    }
    Ok(all)
}

/// The name of the app `pid` runs from when its bundle has no id and isn't a background agent,
/// as Cua names apps: its display name, else its name, else its file's.
fn unbundled(pid: i64) -> Option<String> {
    let app = app_of(pid).ok().filter(|a| is_app(a))?;
    let out = std::process::Command::new("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-"])
        .arg(app.join("Contents/Info.plist"))
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let info: Value = serde_json::from_slice(&out.stdout).ok()?;
    let on = |k: &str| info[k] == true || info[k] == "1" || info[k] == "YES";
    if !info["CFBundleIdentifier"].is_null() || on("LSUIElement") || on("LSBackgroundOnly") {
        return None;
    }
    let name = ["CFBundleDisplayName", "CFBundleName"]
        .iter()
        .find_map(|k| info[k].as_str().filter(|n| !n.trim().is_empty()))
        .map(str::to_string)
        .or_else(|| Some(app.file_stem()?.to_string_lossy().into_owned()))?;
    (!name.is_empty()).then_some(name)
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
    // An app twice under one name is listed once: a name is all an agent can give back.
    let mut once: Vec<String> = Vec::new();
    for l in lines {
        let bare = l.trim_end_matches(" (front)");
        match once
            .iter()
            .position(|o| o.trim_end_matches(" (front)") == bare)
        {
            Some(i) if l.ends_with(" (front)") => once[i] = l,
            Some(_) => {}
            None => once.push(l),
        }
    }
    Ok(format!("Running apps:\n{}", once.join("\n")))
}

/// A running app by its name: exact first, else the one it starts.
pub(super) fn find(
    data: &Path,
    name: &str,
    here: &dyn Fn() -> bool,
) -> Result<(i64, String), Value> {
    let all = running(data, here)?;
    // Two apps can share a name, as a headless Chrome for Testing beside a real one: the one on
    // screen. A headless one has windows too, off every screen.
    let of = |a: &&Value| a["name"].as_str().unwrap_or("").to_lowercase() == name.to_lowercase();
    let twins: Vec<&Value> = all.iter().filter(of).collect();
    let shown = (twins.len() > 1)
        .then(|| {
            twins.iter().copied().find(|a| {
                windows(data, a["pid"].as_i64().unwrap_or(0), here)
                    .is_ok_and(|w| w.iter().any(|w| w["is_on_screen"] == true))
            })
        })
        .flatten();
    let app = shown.or_else(|| named(&all, name)).ok_or_else(|| refuse(&format!("No running app is named {name}. `brigadier computer apps` lists them; `open` starts one.")))?;
    let found = app["name"].as_str().unwrap_or(name).to_string();
    blocked(&found, app["bundle_id"].as_str().unwrap_or(""))?;
    Ok((app["pid"].as_i64().unwrap_or(0), found))
}

/// An app by its name in `list_apps`: exact first, else the one it starts.
pub(super) fn named<'a>(all: &'a [Value], name: &str) -> Option<&'a Value> {
    let lower = name.to_lowercase();
    let of = |a: &&Value| a["name"].as_str().unwrap_or("").to_lowercase();
    (all.iter().find(|a| of(a) == lower)).or_else(|| all.iter().find(|a| of(a).starts_with(&lower)))
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

/// Whether a menu or a click goes to the Apple menu or Services, past its app to others and the
/// Mac itself.
// shortcut: by their English names, as macOS gives accessibility; add others as they're met.
pub(super) fn past_app(w: &Words, s: &Sess) -> bool {
    let past = |name: &str| name.trim().eq_ignore_ascii_case("services");
    let apple = |name: &str| name.trim().eq_ignore_ascii_case("apple");
    // A control or any it is in, up to the window: an open menu's items are rows of their own.
    let mut depth = usize::MAX;
    let mut up = |c: &&Control| {
        let parent = !c.reads.is_empty() && c.reads.len() < depth;
        depth = if parent { c.reads.len() } else { depth };
        parent
    };
    match w.verb {
        "menu" => menu_path(w)
            .is_ok_and(|p| (p.len() > 1 && apple(&p[0])) || p.iter().any(|name| past(name))),
        "click" => {
            let n = w.rest.first().map(|n| n.trim_matches(['[', ']']).parse());
            let at = s.controls.iter().position(|c| n == Some(Ok(c.n)));
            let at = s.controls.get(..at.map_or(0, |at| at + 1));
            (at.unwrap_or_default().iter().rev())
                .filter(|c| up(c))
                .any(|c| {
                    (c.role == "AXMenuBarItem" && apple(&c.name))
                        || (c.role.starts_with("AXMenu") && past(&c.name))
                })
        }
        // The Apple menu's own keys: Force Quit, Lock Screen, Log Out.
        "key" => {
            let mut keys: Vec<&str> = (w.rest.join("").split('+'))
                .map(|k| match k.trim().to_lowercase().as_str() {
                    "command" | "cmd" => "cmd",
                    "control" | "ctrl" => "ctrl",
                    "alt" | "option" => "option",
                    "shift" => "shift",
                    "q" => "q",
                    "escape" | "esc" => "escape",
                    _ => "",
                })
                .collect();
            keys.sort_unstable();
            [
                &["cmd", "escape", "option"][..],
                &["cmd", "ctrl", "q"],
                &["cmd", "q", "shift"],
                &["cmd", "option", "q", "shift"],
            ]
            .contains(&keys.as_slice())
        }
        _ => false,
    }
}

/// An app given by its path, as the path leads: a link or a renamed copy of a blocked app is
/// still that app [D903].
pub(super) fn blocked_path(path: &Path) -> Result<(), Value> {
    let real = path.canonicalize().unwrap_or(path.into());
    if !real
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("app"))
    {
        return Ok(());
    }
    let id = std::process::Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
        .arg(real.join("Contents/Info.plist"))
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    blocked(&real.to_string_lossy(), id.as_deref().unwrap_or(""))
}

/// Brigadier itself and the system's security prompts are closed at every level [D903].
pub(super) fn blocked(name: &str, bundle: &str) -> Result<(), Value> {
    // `open` takes an app's path too: …/Brigadier.app is Brigadier.
    let name = Path::new(name)
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or(name);
    if bundle.starts_with("sh.brigadier.")
        || name.eq_ignore_ascii_case("Brigadier")
        || name.eq_ignore_ascii_case("Brigadier Computer Use")
    {
        return Err(refuse(
            "Brigadier can't be used this way: use `brigadier` commands for it.",
        ));
    }
    if [
        "com.apple.SecurityAgent",
        "com.apple.LocalAuthentication.UIAgent",
        "com.apple.CoreAuthUI",
    ]
    .contains(&bundle)
    {
        return Err(refuse("That's a security prompt: ask the user."));
    }
    Ok(())
}

/// The app a process runs as: the innermost bundle its file is in, else the file.
pub(super) fn app_of(pid: i64) -> Result<PathBuf, Value> {
    let exe = i32::try_from(pid)
        .ok()
        .filter(|p| *p > 0)
        .and_then(procs::exe);
    let exe = exe.ok_or_else(|| refuse("That app isn't running any more: read it again."))?;
    let exe = exe.canonicalize().unwrap_or(exe);
    let app = exe.ancestors().find(|p| is_app(p)).map(Path::to_path_buf);
    Ok(app.unwrap_or(exe))
}

pub(super) fn is_app(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("app"))
}
