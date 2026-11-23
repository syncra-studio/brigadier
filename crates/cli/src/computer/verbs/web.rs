//! Web pages in Brigadier's browser [D2032]: a browser app closed to computer use while the switch
//! is on, unless the user named it.

use super::lock;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{LazyLock, Mutex};

/// Why a browser app is closed to computer use, or `None` where it isn't: while Settings › Computer
/// use › Web pages in Brigadier's browser is on, web pages go to `brigadier browser`, unless the
/// user named this browser in the chat, this session's or its lead's [D2032]. `address`: its
/// window has an address bar.
pub(super) fn web_page(data: &Path, me: &str, app: &str, address: bool) -> Option<String> {
    // shortcut: browsers by name; an address bar also tells one, once a read has seen it.
    const BROWSERS: [&str; 11] = [
        "chrome", "chromium", "safari", "firefox", "edge", "brave", "arc", "dia", "opera",
        "vivaldi", "helium",
    ];
    let words = |t: &str| -> Vec<String> {
        (t.to_lowercase().split(|c: char| !c.is_alphanumeric()))
            .filter(|w| !w.is_empty())
            .map(String::from)
            .collect()
    };
    let named = words(app);
    let browser = address || named.iter().any(|w| BROWSERS.contains(&w.as_str()));
    if !browser || crate::settings::get(data, super::super::WEB) != "true" {
        return None;
    }
    // The user's own words, here and in the chat that started this worker; once named, it stays so.
    static NAMED: LazyLock<Mutex<HashSet<(String, String)>>> = LazyLock::new(Mutex::default);
    let key = (me.to_string(), app.to_string());
    if lock(&NAMED).contains(&key) {
        return None;
    }
    let (root, _) = crate::workers::place(data, me);
    let said = [me, root.as_str()].iter().any(|id| {
        (crate::relay::archive(data, id, false).iter())
            .filter(|e| e.from == "user")
            .any(|e| {
                let theirs = words(&e.text);
                // A name that is a word too counts only capitalised: "the edge of the card" isn't Edge.
                let capital = |w: &str| {
                    let w = format!("{}{}", w[..1].to_uppercase(), &w[1..]);
                    (e.text.split(|c: char| !c.is_alphanumeric())).any(|t| t == w)
                };
                (named.iter())
                    .filter(|w| {
                        !["google", "microsoft", "browser", "for", "testing"].contains(&w.as_str())
                    })
                    .any(
                        |w| match ["edge", "arc", "brave", "opera"].contains(&w.as_str()) {
                            true => capital(w),
                            false => theirs.contains(w),
                        },
                    )
            })
    });
    if said {
        lock(&NAMED).insert(key);
    }
    (!said).then(|| format!(
        "{app} is a browser, and web pages go to Brigadier's browser: `brigadier browser open <url>`, then `brigadier browser snapshot`. \
         Reading {app} stays open to you. The user's sign-ins come over in Settings › Import Browser Data, from {app}'s profile: ask them to bring them there. \
         Computer use acts in {app} only once the user names it in the chat, or turns off Settings › Computer use › Web pages in Brigadier's browser."
    ))
}
