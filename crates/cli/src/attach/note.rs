//! `note <id> read <note> | write <note> <head> <body> --base <rev> | list | delete <note> |
//! chat <note> <chat-id> [--new | --open] | chats`: the session's notes, one Markdown file each
//! under `notes/` in its folder, so they go with it [D244], as the old app's pages: `# <head>`,
//! then the body. The app names a note; it's kept once written, and emptied it goes, so no blank
//! note is ever listed. A note's revision is a hash of its file, and a write based on an older one
//! is refused, so the note's side chat and the user's typing never overwrite each other [D281].
//!
//! Its side chat is a session of its own, hidden from the sidebar, on the session's agent at Auto,
//! working in `notes/` and reading the checkout. Its chats' ids are kept in `notes/<note>.chat`, one
//! a line, the last the one it shows; they stay when its tab closes, for the History menu, and go
//! with the note or the session [D281, D282, D288]. Home's note has one too, on the new chat's
//! picked agent, and it comes into the session with the note [D287].

use crate::{HOME_DRAFT, arg, flag, has, models, remove};
use brigadier_core::{self as core, check_id, message::MAX_BYTES, projects};
use serde_json::{Value, json};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use std::{fs, io};

/// A note's name, as its tab and the New tab show it: its first line, without a heading's #s.
fn title(text: &str) -> &str {
    text.lines()
        .map(|line| line.trim_start_matches('#').trim())
        .find(|line| !line.is_empty())
        .unwrap_or("")
}

/// Home's notes, before the first message makes its session: they go to it then, and one whose
/// tab is closed first goes (`tabs.rs`) [D280].
pub fn home(data: &Path) -> PathBuf {
    data.join("home-notes")
}

/// A note's file as its head (the `# ` line: the emoji and title) and its body; a file that
/// doesn't start with one is all body.
fn split(text: &str) -> (&str, &str) {
    let (first, rest) = text.split_once('\n').unwrap_or((text, ""));
    match first.strip_prefix('#') {
        Some(head) if head.is_empty() || head.starts_with(' ') => {
            (head.trim(), rest.strip_prefix('\n').unwrap_or(rest))
        }
        _ => ("", text),
    }
}

/// The file for a head and body; an untitled body that starts with a heading keeps a bare `#`
/// above it, so it isn't read back as the title.
fn join(head: &str, body: &str) -> String {
    match head.trim() {
        "" if body.starts_with('#') => format!("#\n\n{body}"),
        "" => body.to_string(),
        head => format!("# {head}\n\n{body}"),
    }
}

fn revision(text: &str) -> String {
    let mut hash = DefaultHasher::new();
    text.hash(&mut hash);
    format!("{:016x}", hash.finish())
}

fn read_text(path: &Path) -> io::Result<String> {
    match fs::read_to_string(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        read => read,
    }
}

fn shown(text: &str) -> Value {
    let (head, body) = split(text);
    json!({"head": head, "body": body, "revision": revision(text), "title": title(text)})
}

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    // Home's notes have no session yet: their side chat takes the new chat's pick [D287].
    let (dir, spec) = if id == HOME_DRAFT {
        (home(data), None)
    } else {
        let spec = core::load(data, id)?;
        (core::session_dir(data, id).join("notes"), Some(spec))
    };
    let file = |note: &str| check_id(note).map(|()| dir.join(format!("{note}.md")));
    match arg(args, 2)? {
        // One not written yet reads empty: a new note's tab.
        "read" => {
            let note = arg(args, 3)?;
            let mut reply = shown(&read_text(&file(note)?)?);
            reply["ok"] = true.into();
            reply["chat"] = chat_of(&dir, note).into();
            Ok(reply)
        }
        "write" => {
            let (path, head, body) = (file(arg(args, 3)?)?, arg(args, 4)?, arg(args, 5)?);
            let text = join(head, body);
            if text.len() as u64 > MAX_BYTES {
                return Ok(json!({"ok": false, "error": "This note is too long to keep."}));
            }
            // Changed since the app read it (its side chat, say): refused with what it holds now.
            let now = read_text(&path)?;
            if flag(args, "--base").is_some_and(|base| base != revision(&now)) {
                let mut reply = shown(&now);
                reply["ok"] = false.into();
                reply["conflict"] = true.into();
                return Ok(reply);
            }
            if text.trim().is_empty() {
                remove(&path)?;
            } else {
                fs::create_dir_all(&dir)?;
                core::write_atomic(&path, text.as_bytes())?;
            }
            Ok(json!({"ok": true, "title": title(&text), "revision": revision(&text)}))
        }
        "delete" => {
            let note = arg(args, 3)?;
            drop_chat(data, &dir, note)?;
            remove(&file(note)?)?;
            Ok(json!({"ok": true}))
        }
        // The note's side chat, made on first use under the app's id, anew with --new, or one of
        // the session's earlier ones reopened here with --open [D288].
        "chat" => {
            let (note, chat) = (arg(args, 3)?, arg(args, 4)?);
            let path = file(note)?;
            check_id(chat)?;
            let mut mine = chats_of(&dir, note);
            if has(args, "--open") {
                let Some((was, _)) = all_chats(&dir).into_iter().find(|(_, c)| c == chat) else {
                    return Err(io::Error::other("not one of this session's side chats"));
                };
                let mut theirs = chats_of(&dir, &was);
                theirs.retain(|c| c != chat);
                set_chats(&dir, &was, &theirs)?;
                mine.retain(|c| c != chat);
                mine.push(chat.into());
                set_chats(&dir, note, &mine)?;
                let mut moved = core::load(data, chat)?;
                moved.opts.insert("note".into(), path.display().to_string());
                resave(&moved)?;
                return Ok(json!({"ok": true, "chat": chat}));
            }
            if !has(args, "--new")
                && let Some(kept) = mine.last()
            {
                return Ok(json!({"ok": true, "chat": kept}));
            }
            let pick = match &spec {
                Some(spec) => session_pick(spec)?,
                None => home_pick(data, args)?,
            };
            // A model a rule bars is refused before anything is made, as Send as new's [D388 Q10].
            if let Err(e) =
                crate::routing::launch(data, &pick.0, pick.1.as_deref(), pick.2.as_deref())
            {
                return Ok(json!({"ok": false, "result": "refused", "error": e}));
            }
            // Kept first: a start cut short is still found, and deleted, with the session.
            fs::create_dir_all(&dir)?;
            mine.push(chat.into());
            set_chats(&dir, note, &mine)?;
            crate::run(data, &start_args(pick, &dir, &path, chat))?;
            Ok(json!({"ok": true, "chat": chat}))
        }
        "chats" => {
            let chats: Vec<String> = all_chats(&dir).into_iter().map(|(_, c)| c).collect();
            Ok(json!({"ok": true, "chats": chats}))
        }
        // The newest first, as the old New tab's Recents.
        "list" => {
            let mut notes: Vec<(u64, Value)> = vec![];
            for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
                let path = entry.path();
                let Some(note) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                if path.extension().is_none_or(|e| e != "md") || check_id(note).is_err() {
                    continue;
                }
                let at = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as u64);
                let text = fs::read_to_string(&path).unwrap_or_default();
                notes.push((at, json!({"id": note, "title": title(&text), "at": at})));
            }
            notes.sort_by_key(|n| std::cmp::Reverse(n.0));
            Ok(json!({"ok": true, "notes": notes.into_iter().map(|(_, n)| n).collect::<Vec<_>>()}))
        }
        _ => Err(io::Error::other(crate::USAGE)),
    }
}

/// The note's side chats, oldest first.
fn chats_of(dir: &Path, note: &str) -> Vec<String> {
    let kept = fs::read_to_string(dir.join(format!("{note}.chat"))).unwrap_or_default();
    (kept.lines().map(str::trim))
        .filter(|c| check_id(c).is_ok())
        .map(String::from)
        .collect()
}

/// The side chat the note shows, if it has one.
fn chat_of(dir: &Path, note: &str) -> Option<String> {
    chats_of(dir, note).pop()
}

fn set_chats(dir: &Path, note: &str, chats: &[String]) -> io::Result<()> {
    let path = dir.join(format!("{note}.chat"));
    match chats {
        [] => remove(&path),
        _ => core::write_atomic(&path, chats.join("\n").as_bytes()),
    }
}

/// Every side chat of the session's notes, by note.
fn all_chats(dir: &Path) -> Vec<(String, String)> {
    let mut all = vec![];
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "chat")
            && let Some(note) = path.file_stem().and_then(|s| s.to_str())
        {
            all.extend(
                chats_of(dir, note)
                    .into_iter()
                    .map(|c| (note.to_string(), c)),
            );
        }
    }
    all
}

/// A side chat's spec as changed here: the note it builds, or the folders it works in.
fn resave(spec: &core::Spec) -> io::Result<()> {
    core::write_atomic(
        &spec.dir.join("session.json"),
        serde_json::to_string_pretty(spec)?.as_bytes(),
    )
}

/// Deletes the note's side chats, their record last, so a delete cut short is done again.
pub(crate) fn drop_chat(data: &Path, dir: &Path, note: &str) -> io::Result<()> {
    for chat in chats_of(dir, note) {
        if core::session_dir(data, &chat).join("session.json").exists() {
            crate::sessions::delete(data, &chat, false, "delete")?;
        }
    }
    remove(&dir.join(format!("{note}.chat")))
}

/// Every side chat of a session's notes, for its delete.
pub(crate) fn drop_chats(data: &Path, session: &Path) -> io::Result<()> {
    let dir = session.join("notes");
    for (note, _) in all_chats(&dir) {
        drop_chat(data, &dir, &note)?;
    }
    Ok(())
}

/// Home's side chats, come into session `to` with their notes: each works in its notes folder now
/// and reads its checkout, as one made there would [D287].
pub(crate) fn carried(data: &Path, to: &core::Spec) -> io::Result<()> {
    let dir = to.dir.join("notes");
    for (note, chat) in all_chats(&dir) {
        let Ok(mut spec) = core::load(data, &chat) else {
            continue;
        };
        spec.cwd = dir.display().to_string();
        let path = dir.join(format!("{note}.md")).display().to_string();
        spec.opts.insert("note".into(), path);
        spec.opts.insert("reads".into(), to.cwd.clone());
        resave(&spec)?;
    }
    Ok(())
}

/// What a side chat runs on: an agent, its model and effort, and the checkout it may read.
type Pick = (String, Option<String>, Option<String>, Option<PathBuf>);

/// A session's: its next agent, model and effort, as Send as new takes them [D281, D282].
fn session_pick(src: &core::Spec) -> io::Result<Pick> {
    let f = core::fold(&src.dir, true)?.fold;
    let backend = models::next_agent(src, &f).to_string();
    let run = core::as_run(src, &f, &backend, None);
    let (model, effort) = match &f.picked {
        Some(p) => (Some(p.model.clone()), p.effort.clone()),
        None => (run.model, run.effort),
    };
    Ok((backend, model, effort, Some(src.cwd.clone().into())))
}

/// Home's: what the new chat has picked, and its project's folder, if one is [D287].
fn home_pick(data: &Path, args: &[String]) -> io::Result<Pick> {
    let backend = flag(args, "--backend").ok_or_else(|| io::Error::other(crate::USAGE))?;
    let reads = flag(args, "--project")
        .and_then(|p| projects::get(data, p).ok())
        .map(|p| p.folder.into());
    let opt = |name| flag(args, name).map(String::from);
    Ok((backend.into(), opt("--model"), opt("--effort"), reads))
}

/// The side chat's start, at Auto in the notes folder, reading the checkout [D281, D282].
fn start_args(pick: Pick, dir: &Path, note: &Path, chat: &str) -> Vec<String> {
    let (backend, model, effort, reads) = pick;
    let path = |p: &Path| p.display().to_string();
    let mut args: Vec<String> = vec![
        "start".into(),
        chat.into(),
        "--backend".into(),
        backend,
        "--cwd".into(),
        path(dir),
        "--level".into(),
        "auto".into(),
        "--opt".into(),
        format!("note={}", path(note)),
    ];
    // A projectless chat's scratch folder may not be made yet: nothing to read there then.
    if let Some(reads) = reads.filter(|r| r.is_dir()) {
        args.extend(["--opt".into(), format!("reads={}", path(&reads))]);
    }
    for (name, value) in [("--model", model), ("--effort", effort)] {
        if let Some(v) = value {
            args.extend([name.into(), v]);
        }
    }
    args
}
