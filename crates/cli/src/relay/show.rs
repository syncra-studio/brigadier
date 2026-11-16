//! `brigadier show <file[:line]|url>`: an agent shows the user a file or a page in its own
//! session's tabs [D506, D519].

use crate::tabs::{run, target::relative};
use brigadier_core::git;
use serde_json::{Value, json};
use std::path::Path;

/// A web page opens in a browser tab, one already on that page reused; a file of the checkout in
/// the viewer at its line, as a file chip opens it [D251]. A worker's tab opens behind: only the
/// thread brings a tab to the front [D519]. Any other address, `file://` too, is refused.
pub fn show(data: &Path, me: &str, what: &str) -> Value {
    let refuse = |message: String| json!({"ok": false, "error": message});
    let web = ["http://", "https://"].iter().any(|s| {
        what.get(..s.len())
            .is_some_and(|w| w.eq_ignore_ascii_case(s))
    });
    let (path, line) = match what.rsplit_once(':') {
        Some((path, line)) if line.parse::<u32>().is_ok() => (path, line),
        _ => (what, "-"),
    };
    if what.is_empty() || !web && (what.contains("://") || path.contains(':')) {
        return refuse(format!(
            "Only a file of your checkout (path[:line]) or an http(s) address can be shown, not {what:?}. To show an .html file rendered, serve it and show its address."
        ));
    }
    let tab = format!("t-{}", crate::control::new_cid());
    let mut args: Vec<String> = if web {
        ["tabs", me, "open", &tab, "browser", what]
            .map(String::from)
            .into()
    } else {
        let file = match relative(data, me, path.trim_start_matches("./").into()).and_then(|rel| {
            let root = git::checkout(data, &git::Target::Session(me))?.root;
            match root.join(&rel).is_file() {
                true => Ok(rel),
                false => Err(std::io::Error::other(format!(
                    "No file {rel} in your checkout."
                ))),
            }
        }) {
            Ok(file) => file,
            Err(e) => return refuse(e.to_string()),
        };
        ["tabs", me, "file", &tab, &file, line, "keep"]
            .map(String::from)
            .into()
    };
    let behind = crate::workers::link(data, me).is_some();
    if behind {
        args.push("--behind".into());
    }
    match run(data, &args) {
        Ok(_) if behind => {
            json!({"ok": true, "text": format!("Opened {what} in a tab behind; the user sees it when they look at your session.")})
        }
        Ok(_) => json!({"ok": true, "text": format!("Showing {what} to the user.")}),
        Err(e) => refuse(e.to_string()),
    }
}
