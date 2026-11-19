//! `note <id> read <note> | write <note> <head> <body> --base <rev> | list | delete <note> |
//! chat <note> <chat-id> [--new | --open] | chats`, `--project <p>` on Home's: the project's notes,
//! one Markdown file each in its notes folder, so they outlive its sessions; chats in no project
//! share one [D244, D913, D921]. As the old app's pages: `# <head>`,
//! then the body. The app names a note; it's kept once written, and emptied it goes, so no blank
//! note is ever listed. A note's revision is a hash of its file, and a write based on an older one
//! is refused, so the note's side chat and the user's typing never overwrite each other [D281].
//!
//! Its side chat is a session of its own, hidden from the sidebar, on the session's agent at Auto,
//! working in the notes folder and reading the project's. Its chats' ids are kept in `<note>.chat`,
//! one a line, the last the one it shows; they stay when its tab closes, for the History menu, and
//! go with the note or the project [D281, D282, D288]. Home's note has one too, on the new chat's
//! picked agent [D287].

mod list;
mod moved;

use crate::{HOME_DRAFT, arg, flag, has, models, remove};
use brigadier_core::{self as core, check_id, message::MAX_BYTES, projects};
use serde_json::{Value, json};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::{fs, io};

/// A note's name, as its tab and lists show it: the one it was renamed to, else its first line of
/// text, without a heading's #s [D913].
fn title(text: &str) -> &str {
    let (head, body) = split(text);
    match named(head) {
        "" => (body.lines().map(plain))
            .find(|line| !line.is_empty())
            .unwrap_or(""),
        name => name,
    }
}

/// A line as words, its Markdown marks off: a heading's #s, a list's or checklist's, a quote's.
fn plain(line: &str) -> &str {
    let line = line.trim().trim_start_matches('#').trim_start();
    let line = ["- [ ] ", "- [x] ", "- [X] ", "- ", "* ", "+ ", "> "]
        .iter()
        .find_map(|mark| line.strip_prefix(mark))
        .unwrap_or(line);
    let digits = line.trim_start_matches(|c: char| c.is_ascii_digit());
    (digits.len() < line.len())
        .then(|| digits.strip_prefix(". "))
        .flatten()
        .unwrap_or(line)
        .trim()
}

/// The name in a note's `# ` line, without the emoji that may lead it; empty: it was never renamed.
fn named(head: &str) -> &str {
    head.trim_start_matches(|c: char| !c.is_ascii() && !c.is_alphanumeric())
        .trim()
}

/// A project's notes folder, removed with it [D920], or the one chats in no project share [D921].
pub(crate) fn folder(data: &Path, project: Option<&str>) -> PathBuf {
    project.map_or(data.join("notes"), |p| projects::dir(data, p).join("notes"))
}

/// The notes folder of a session's project, or Home's picked one (`--project`).
fn folder_of(data: &Path, owner: &str, args: &[String]) -> io::Result<PathBuf> {
    let project = if owner == HOME_DRAFT {
        flag(args, "--project").map(String::from)
    } else {
        let spec = core::load(data, owner)?;
        // A note's side chat: its note's folder, which no project's root holds [D922].
        if let Some(dir) = spec.opts.get("note").and_then(|n| Path::new(n).parent()) {
            return Ok(dir.to_path_buf());
        }
        projects::of(
            &spec,
            &projects::list(data)?,
            &mut projects::Roots::default(),
        )
    };
    if let Some(p) = &project {
        check_id(p)?;
    }
    Ok(folder(data, project.as_deref()))
}

/// Where a note's file is: in `dir`, still in its session waiting to move, or in another project's
/// folder (a Home note whose project was changed after); one not written yet, in `dir`.
fn locate(data: &Path, dir: &Path, note: &str) -> io::Result<PathBuf> {
    check_id(note)?;
    let name = format!("{note}.md");
    if dir.join(&name).exists() {
        return Ok(dir.join(name));
    }
    let others = (fs::read_dir(data.join("projects"))
        .into_iter()
        .flatten()
        .flatten())
    .map(|e| e.path().join("notes"))
    .chain([data.join("notes")]);
    Ok((moved::waiting(data, note).into_iter())
        .chain(others.map(|d| d.join(&name)))
        .find(|p| p.exists())
        .unwrap_or_else(|| dir.join(name)))
}

/// The project's notes as the notes column lists them, for the `@` menu and the agent's `notes`.
pub(crate) fn listed(data: &Path, owner: &str, project: Option<&str>) -> io::Result<Vec<Value>> {
    settle(data);
    let args: Vec<String> = project
        .map(|p| vec!["--project".into(), p.into()])
        .unwrap_or_default();
    let dir = folder_of(data, owner, &args)?;
    Ok(list::run(data, &dir, None)["notes"]
        .as_array()
        .cloned()
        .unwrap_or_default())
}

/// A note of `owner`'s project by its id: its file and text; None if it has none.
pub(crate) fn text_of(
    data: &Path,
    owner: &str,
    note: &str,
) -> io::Result<Option<(PathBuf, String)>> {
    let path = locate(data, &folder_of(data, owner, &[])?, note)?;
    Ok(fs::read_to_string(&path).ok().map(|text| (path, text)))
}

/// A note's emoji and name, as its chip and menu row show it.
pub(crate) fn shown_name(note: &Value) -> String {
    let (head, title) = (
        note["head"].as_str().unwrap_or(""),
        note["title"].as_str().unwrap_or(""),
    );
    let emoji = head[..head.len() - named(head).len()].trim();
    let title = if title.is_empty() {
        "Untitled note"
    } else {
        title
    };
    format!("{emoji} {title}").trim().to_string()
}

/// Moves notes still in their sessions to their projects, as far as they can go now [D916].
pub(crate) fn settle(data: &Path) {
    let _ = moved::settle(data);
}

/// Whether a session still holds a note waiting to move.
pub(crate) use moved::holds;

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
    settle(data);
    let dir = folder_of(data, id, args)?;
    // Home's notes have no session yet: their side chat takes the new chat's pick [D287].
    let spec = (id != HOME_DRAFT)
        .then(|| core::load(data, id))
        .transpose()?;
    // A note's file, and the folder it and its chats' record are in.
    let at = |note: &str| -> io::Result<(PathBuf, PathBuf)> {
        let path = locate(data, &dir, note)?;
        Ok((path.parent().unwrap_or(&dir).to_path_buf(), path))
    };
    match arg(args, 2)? {
        // One not written yet reads empty: a new note's tab.
        "read" => {
            let note = arg(args, 3)?;
            let (home, path) = at(note)?;
            let mut reply = shown(&read_text(&path)?);
            reply["ok"] = true.into();
            reply["chat"] = chat_of(&home, note).into();
            Ok(reply)
        }
        "write" => {
            let ((home, path), head, body) = (at(arg(args, 3)?)?, arg(args, 4)?, arg(args, 5)?);
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
                fs::create_dir_all(&home)?;
                core::write_atomic(&path, text.as_bytes())?;
            }
            Ok(json!({"ok": true, "title": title(&text), "revision": revision(&text)}))
        }
        "delete" => {
            let note = arg(args, 3)?;
            let (home, path) = at(note)?;
            drop_chat(data, &home, note)?;
            remove(&path)?;
            Ok(json!({"ok": true}))
        }
        // The note's side chat, made on first use under the app's id, anew with --new, or one of
        // the project's earlier ones reopened here with --open [D288].
        "chat" => {
            let (note, chat) = (arg(args, 3)?, arg(args, 4)?);
            let (dir, path) = at(note)?;
            check_id(chat)?;
            let mut mine = chats_of(&dir, note);
            if has(args, "--open") {
                let Some((was, _)) = all_chats(&dir).into_iter().find(|(_, c)| c == chat) else {
                    return Err(io::Error::other("not one of this project's side chats"));
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
                Some(spec) => session_pick(data, spec)?,
                None => home_pick(data, args)?,
            };
            // A model a rule bars is refused before anything is made, as Send as new's [D388 Q10].
            if let Err(e) = crate::routing::launch(
                data,
                &dir.display().to_string(),
                &pick.0,
                pick.1.as_deref(),
                pick.2.as_deref(),
            ) {
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
        "list" => Ok(list::run(data, &dir, flag(args, "--q"))),
        "pin" => {
            let note = arg(args, 3)?;
            let (home, _) = at(note)?;
            list::pin(&home, note, arg(args, 4)? == "on")
        }
        // A new name in its `# ` line, its emoji kept; an empty one names it by its text again.
        "rename" => {
            let (note, name) = (arg(args, 3)?, arg(args, 4)?.replace('\n', " "));
            let (_, path) = at(note)?;
            let now = read_text(&path)?;
            let (head, body) = split(&now);
            let emoji = head[..head.len() - named(head).len()].trim();
            let text = join(&format!("{emoji} {}", name.trim()), body);
            if text.trim().is_empty() {
                return Ok(json!({"ok": false, "error": "There's nothing in this note to name."}));
            }
            core::write_atomic(&path, text.as_bytes())?;
            Ok(json!({"ok": true, "title": title(&text), "revision": revision(&text)}))
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

/// Every side chat of a notes folder's notes, by note.
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

/// Every side chat of a notes folder's notes: Remove project checks and deletes them [D922].
pub(crate) fn chats_in(dir: &Path) -> Vec<String> {
    all_chats(dir).into_iter().map(|(_, c)| c).collect()
}

/// Every side chat of a notes folder's notes, for its project's removal.
pub(crate) fn drop_chats(data: &Path, dir: &Path) -> io::Result<()> {
    for (note, _) in all_chats(dir) {
        drop_chat(data, dir, &note)?;
    }
    Ok(())
}

/// What a side chat runs on: an agent, its model and effort, and the checkout it may read.
type Pick = (String, Option<String>, Option<String>, Option<PathBuf>);

/// A session's: its next agent, model and effort, as Send as new takes them, reading its project's
/// folder, which outlives the session as the note does [D281, D282, D913].
fn session_pick(data: &Path, src: &core::Spec) -> io::Result<Pick> {
    let f = core::fold(&src.dir, true)?.fold;
    let backend = models::next_agent(src, &f).to_string();
    let run = core::as_run(src, &f, &backend, None);
    let (model, effort) = match &f.picked {
        Some(p) => (Some(p.model.clone()), p.effort.clone()),
        None => (run.model, run.effort),
    };
    let list = projects::list(data)?;
    let reads = projects::of(src, &list, &mut projects::Roots::default())
        .and_then(|p| list.into_iter().find(|x| x.id == p))
        .map(|p| p.folder.into());
    Ok((backend, model, effort, reads))
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
