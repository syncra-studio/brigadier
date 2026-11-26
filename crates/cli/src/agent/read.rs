//! `brigadier read`'s modes past the last messages and one reference [repo-merge D85; §2.7]: a range
//! in pages under the reply cap, each ending with the command for the next, and any record whole to
//! a file of the reader's own.

use super::{CAP, Call, LAST_MOST, refuse};
use crate::relay::{archive, opened, sender};
use brigadier_core::{self as core, archive::Entry};
use serde_json::{Value, json};
use std::io::Write;
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
    // With the answers given for the user, which aren't entries, in their place by reference (O50).
    let mut all = archive(data, id, true);
    all.extend(core::archive::answers_by(&core::session_dir(data, id)));
    all.sort_by_key(|e| key(&e.at));
    let within = |e: &&Entry| key(&e.at).is_some_and(|k| (a..=b).contains(&k));
    let flag = if user { " --user" } else { "" };
    // Room for the heading and the next page's line.
    let page = CAP - 512;
    let (mut text, mut list, mut next) = (String::new(), vec![], None);
    let picked: Vec<&Entry> = (all.iter().filter(within))
        .filter(|e| !user || e.from == "user")
        .collect();
    let msg = |e: &Entry, words: &str| json!({"ref": format!("{id}#{}", e.at), "from": sender(e), "text": words, "files": e.files});
    // The JSON's bytes so far: `--json` gives it in place of the text, so it pages the same.
    let mut sent = 0;
    // Whole references only: entries sharing one frame page together, or `next` would point back.
    for group in picked.chunk_by(|x, y| x.at == y.at) {
        let at = &group[0].at;
        let mut one: String = group.iter().map(|e| shown(id, e)).collect();
        let whole: Vec<Value> = group.iter().map(|e| msg(e, &e.text)).collect();
        let bytes: usize = whole.iter().map(|m| m.to_string().len() + 1).sum();
        if !text.is_empty() && (text.len() + one.len() > page || sent + bytes > page) {
            next = Some(at.clone());
            break;
        }
        // Too big for a page: cut, the JSON's texts too, with the command that writes it whole.
        if one.len() <= page && bytes <= page {
            (text, sent) = (text + &one, sent + bytes);
            list.extend(whole);
            continue;
        }
        let raw = format!("brigadier read {id}#{at} --raw");
        one = format!("{}…\n[cut: {raw} writes it whole]\n\n", start(&one, page));
        text += &one;
        // Measured as sent, escapes and all: each text shrinks till its message fits what's left,
        // and once nothing fits, the rest is the --raw file's alone.
        let mut left = page;
        for e in group {
            let mut words = start(&e.text, left);
            let m = loop {
                let mut m = msg(e, words);
                if words.len() < e.text.len() {
                    m["cut"] = raw.as_str().into();
                }
                let bytes = m.to_string().len() + 1;
                if bytes <= left || words.is_empty() {
                    break m;
                }
                // In proportion: escapes make a byte of text cost more than one.
                words = start(words, words.len() * left / bytes);
            };
            // Its files alone pass what's left: its reference, how many, and the --raw command.
            let m = match m.to_string().len() + 1 > left {
                true => json!({"ref": m["ref"], "from": m["from"], "text": "", "files": [],
                    "files_cut": e.files.len(), "cut": raw}),
                false => m,
            };
            let bytes = m.to_string().len() + 1;
            if bytes > left {
                break;
            }
            left -= bytes;
            list.push(m);
        }
        if let Some(m) = list.last_mut() {
            m["cut"] = raw.as_str().into();
        }
        // It filled the page: the next reference starts the next.
        sent = page;
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

/// The first `max` bytes of `s`, on a character boundary.
fn start(s: &str, max: usize) -> &str {
    let mut end = max.min(s.len());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
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
            // Only the kinds a read shows: no other record leaves its log, as a launch's argv may
            // hold an MCP server's credentials: no command prints a secret [D2026].
            _ => continue,
        };
        let name = [s("kind"), s("name"), s("event")].join(" ");
        out += &format!(
            "[{id}#{at} {}]\n{body}\n",
            name.split_whitespace().collect::<Vec<_>>().join(" ")
        );
    }
    if out.is_empty() {
        return refuse(&format!(
            "{id}#{at} is no message, step or summary: `brigadier search` gives those."
        ));
    }
    let dir = core::session_dir(data, me).join("tmp");
    let name = format!("read-{id}-{at}.txt");
    let path = dir.join(&name);
    let wrote = create(&dir, &name).and_then(|mut file| file.write_all(out.as_bytes()));
    if let Err(e) = wrote {
        return refuse(&format!("Couldn't write {}: {e}", path.display()));
    }
    let path = path.display().to_string();
    json!({"ok": true, "path": path, "bytes": out.len(), "text": format!("{id}#{at}, whole: {path} ({} bytes)\n", out.len())})
}

/// `name` made new in `dir`, neither followed as a link: the agent can write its own `tmp/`, and a
/// link it put there must not send the daemon's write outside its session (ARCHITECTURE).
fn create(dir: &Path, name: &str) -> std::io::Result<std::fs::File> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    let c = |b: &[u8]| std::ffi::CString::new(b).map_err(std::io::Error::other);
    let _ = std::fs::create_dir(dir);
    let (dir, name) = (c(dir.as_os_str().as_bytes())?, c(name.as_bytes())?);
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: plain calls on NUL-terminated paths; each fd returned is owned once, below.
    let fd = unsafe { libc::open(dir.as_ptr(), flags) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let dir = unsafe { OwnedFd::from_raw_fd(fd) };
    // An earlier copy, or a link put in its place: only the name goes, never what it points at.
    unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) };
    let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags, 0o600 as libc::c_uint) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}
