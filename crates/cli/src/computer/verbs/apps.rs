//! The running apps by name, one line each, and an app's menus by path: what an agent names an app
//! or a menu item with [D922 D928].

use super::diff::Control;
use super::open::{front, own, windows};
use super::{Sess, Words, call, refuse};
use serde_json::{Value, json};
use std::path::Path;

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
        _ => false,
    }
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
