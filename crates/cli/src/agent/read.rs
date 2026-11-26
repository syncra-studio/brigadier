//! `brigadier read`'s modes past the last messages and one reference [repo-merge D85; §2.7]: a range
//! in pages under the reply cap, each ending with the command for the next, and any record whole to
//! a file of the reader's own.

use super::{CAP, Call, LAST_MOST, refuse};
use crate::relay::{archive, opened, sender};
use brigadier_core::{self as core, archive::Entry};
use serde_json::{Value, json};
use std::path::Path;

/// One entry as every read shows it, under its reference.
pub(crate) fn shown(id: &str, e: &Entry) -> String {
    let files = match e.files.is_empty() {
        true => String::new(),
        false => format!("\n(files: {})", e.files.join(", ")),
    };
    format!(
        "[{id}#{} {}]\n{}{files}\n\n",
        e.at,
        sender(e),
        e.text.trim_end()
    )
}

pub(super) fn run(
    data: &Path,
    me: &str,
    id: &str,
    at: Option<&str>,
    call: &Call,
    row: &Value,
) -> Result<Value, Value> {
    let user = call.has("--user");
    match (at, call.value("--to"), call.has("--raw")) {
        (Some(at), Some(to), false) => Ok(range(data, id, row, at, to, user)),
        (Some(at), None, true) => Ok(raw(data, me, id, at)),
        (None, Some(_), _) => Err(refuse(
            "--to reads a range from a reference: brigadier read <id>#<from> --to <to>.",
        )),
        (None, _, true) => Err(refuse(
            "--raw writes out a reference: brigadier read <id>#<n> --raw.",
        )),
        (_, Some(_), true) => Err(refuse("--raw takes one reference, not a range.")),
        (Some(_), None, false) => call
            .number("--around", 3, LAST_MOST)
            .map(|n| crate::relay::read(data, id, row, at, n, user)),
        (None, None, false) => call
            .number("--last", 10, LAST_MOST)
            .map(|n| crate::relay::read(data, id, row, at, n, user)),
    }
}

/// Every entry from `at` to `to`, steps included (only the user's with `user`), as many as fit a
/// page; the page ends with the command for the next.
fn range(data: &Path, id: &str, row: &Value, at: &str, to: &str, user: bool) -> Value {
    // In log order: a fork's inherited lines, then its own frames; either end need not be an entry.
    let key = |r: &str| match r.strip_prefix('i') {
        Some(n) => n.parse().ok().map(|n: u64| (0, n)),
        None => r.parse().ok().map(|n: u64| (1, n)),
    };
    let (Some(a), Some(b)) = (key(at), key(to)) else {
        return refuse("A range runs between two references, such as #12 --to 40 or #i3 --to i9.");
    };
    if b < a {
        return refuse(&format!("#{to} comes before #{at}."));
    }
    let all = archive(data, id, true);
    let within = |e: &&Entry| key(&e.at).is_some_and(|k| (a..=b).contains(&k));
    let flag = if user { " --user" } else { "" };
    // Room for the heading and the next page's line.
    let page = CAP - 512;
    let (mut text, mut list, mut next) = (String::new(), vec![], None);
    for e in all
        .iter()
        .filter(within)
        .filter(|e| !user || e.from == "user")
    {
        let mut one = shown(id, e);
        if !text.is_empty() && text.len() + one.len() > page {
            next = Some(e.at.clone());
            break;
        }
        if one.len() > page {
            let mut end = page;
            while !one.is_char_boundary(end) {
                end -= 1;
            }
            one = format!(
                "{}…\n[cut: brigadier read {id}#{} --raw writes it whole]\n\n",
                &one[..end],
                e.at
            );
        }
        text += &one;
        list.push(json!({"ref": format!("{id}#{}", e.at), "from": sender(e), "text": e.text, "files": e.files}));
    }
    if text.is_empty() {
        text = "[nothing in this range]\n".into();
    }
    if let Some(n) = &next {
        text += &format!("[more: brigadier read {id}#{n} --to {to}{flag}]\n");
    }
    let mut reply = opened(data, id, row, text, list, 0);
    reply["next"] = next.map(|n| format!("{id}#{n}")).into();
    reply
}

/// The items under a reference, whole and uncapped, written to the reader's own `tmp/`.
fn raw(data: &Path, me: &str, id: &str, at: &str) -> Value {
    let items = match core::archive::items(&core::session_dir(data, id), at) {
        Ok(items) if !items.is_empty() => items,
        Ok(_) => {
            return refuse(&format!(
                "{id} has no #{at}. `brigadier search` gives references."
            ));
        }
        Err(e) => return refuse(&format!("{id}'s log can't be read: {e}")),
    };
    let mut out = String::new();
    for item in &items {
        let s = |k: &str| item[k].as_str().unwrap_or("");
        let body = match s("kind") {
            "tool" => s("input").to_string(),
            "tool_done" => s("output").to_string(),
            "input" => core::archive::answer(item).unwrap_or_else(|| s("text").to_string()),
            "text" => s("text").to_string(),
            "failed" => s("message").to_string(),
            _ if item["event"] == "summary" => s("text").to_string(),
            _ => serde_json::to_string_pretty(item).unwrap_or_default(),
        };
        let name = [s("kind"), s("name"), s("event")].join(" ");
        out += &format!(
            "[{id}#{at} {}]\n{body}\n",
            name.split_whitespace().collect::<Vec<_>>().join(" ")
        );
    }
    let dir = core::session_dir(data, me).join("tmp");
    let path = dir.join(format!("read-{id}-{at}.txt"));
    if let Err(e) = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&path, &out)) {
        return refuse(&format!("Couldn't write {}: {e}", path.display()));
    }
    let path = path.display().to_string();
    json!({"ok": true, "path": path, "bytes": out.len(), "text": format!("{id}#{at}, whole: {path} ({} bytes)\n", out.len())})
}
