//! `attach <@home|id> add <aid> <name> --backend B (--path P | --data BASE64) | read <aid> | write <aid> <text> | remove <aid> | list | view <path> | reveal <path>`
//! and `draft <@home|id> [<json>|""]`: the composer's files and its unsent draft, kept by Rust
//! under the session's folder (book.rs), or Home's until Send makes its session [D35, D127, D363,
//! D2022]; and `note`, the session's notes (note.rs). A paired device's own draft and files are
//! its slot's (`--slot`, slot.rs) [D51].

pub(crate) mod book;
pub(crate) mod note;
pub(crate) mod slot;

use super::{HOME_DRAFT, arg, flag};
use brigadier_core::git::{self, Target};
use brigadier_core::message::{self, MAX_BYTES, draft_of, file_in, is_image, sent};
use brigadier_core::{self as core, adapters, check_id};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// `device`: a paired device's, whose files are its slot's alone, never the Mac's [D51].
pub fn run(data: &Path, args: &[String], device: Option<&str>) -> io::Result<Value> {
    if args[0] == "note" {
        return note::run(data, args);
    }
    let owner = arg(args, 1)?;
    let slot = device.map(String::from);
    if owner != HOME_DRAFT {
        let dir = core::load(data, owner)?.dir;
        if device.is_some() {
            slot::made(&dir.join("drafts"))?;
        }
        book::settle_cut(&book::Place::Session(dir, slot))?;
    }
    let folder = match device {
        Some(d) if owner == HOME_DRAFT => book::slot_files(data, d),
        Some(d) => book::slot_files(&core::session_dir(data, owner), d),
        None => draft_of(data, owner)?,
    };
    match arg(args, 2)? {
        // Checked as it's added, so a file that can't go shows failed with why [D487, D492].
        "add" => {
            let (id, name) = (arg(args, 3)?, arg(args, 4)?);
            check_id(id)?;
            let name = Path::new(name)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if name.is_empty() || name.starts_with('.') {
                return Err(io::Error::other("This file has no name to keep it by."));
            }
            // The message's other files, as its composer holds them now: 20 a message at most [D2022].
            let others = flag(args, "--in").map_or(0, |ids| {
                ids.split(',').filter(|i| !i.is_empty() && *i != id).count()
            });
            if others >= message::MAX_FILES {
                let why = format!("at most {} attachments per message", message::MAX_FILES);
                return Ok(json!({"ok": false, "error": why, "full": true}));
            }
            let bytes = match (flag(args, "--path"), flag(args, "--data")) {
                (Some(path), _) => {
                    let size = fs::metadata(path)?.len();
                    if size > MAX_BYTES {
                        return Ok(too_large());
                    }
                    fs::read(path)?
                }
                (None, Some(b64)) => brigadier_frames::unbase64(b64)
                    .ok_or_else(|| io::Error::other("The file's bytes didn't arrive whole."))?,
                _ => return Err(io::Error::other(crate::USAGE)),
            };
            if bytes.len() as u64 > MAX_BYTES {
                return Ok(too_large());
            }
            let file = folder.join(id).join(name);
            if is_image(&file)
                && let Some(why) = flag(args, "--backend")
                    .and_then(adapters::get)
                    .and_then(|a| message::notes::refused(a, &bytes))
            {
                return Ok(json!({"ok": false, "error": why}));
            }
            fs::create_dir_all(file.parent().unwrap())?;
            core::write_atomic(&file, &bytes)?;
            Ok(json!({"ok": true, "id": id}))
        }
        // One opened in its tab, as the Files viewer reads a file, the draft's or a sent one [D2104].
        "read" => {
            let id = arg(args, 3)?;
            check_id(id)?;
            let sent_dir = (owner != HOME_DRAFT).then(|| sent(&core::session_dir(data, owner)));
            let found = (file_in(&folder, id).map(|f| (f, folder.clone(), false)))
                .or_else(|| sent_dir.and_then(|d| file_in(&d, id).map(|f| (f, d, true))));
            let Some((file, root, is_sent)) = found else {
                return Ok(json!({"ok": true, "file": {"gone": true}}));
            };
            // A link put in its place never reads outside the owner's folder [D2104].
            if !fs::canonicalize(&file)?.starts_with(fs::canonicalize(&root)?) {
                return Err(io::Error::other("This file isn't one of the message's."));
            }
            let shown = core::git::read_shown(&file, id)?;
            Ok(json!({"ok": true, "file": shown, "sent": is_sent}))
        }
        // An edit to a pasted text in its tab, kept under its id while it's still the draft's [D2098].
        "write" => {
            let (id, text) = (arg(args, 3)?, arg(args, 4)?);
            check_id(id)?;
            let Some(file) = file_in(&folder, id) else {
                return Ok(
                    json!({"ok": false, "error": "This pasted text is no longer in the message."}),
                );
            };
            if text.len() as u64 > MAX_BYTES {
                return Ok(too_large());
            }
            core::write_atomic(&file, text.as_bytes())?;
            Ok(json!({"ok": true}))
        }
        // Taken out of the message: its file goes [D127].
        "remove" => {
            let id = arg(args, 3)?;
            check_id(id)?;
            if device.is_some()
                && draft_of(data, owner).is_ok_and(|mac| file_in(&mac, id).is_some())
            {
                return Ok(json!({"ok": false, "error": "This file isn't in this draft."}));
            }
            match fs::remove_dir_all(folder.join(id)) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
                _ => Ok(json!({"ok": true})),
            }
        }
        // An image a thread's link or reply names, anywhere on disk, copied under the session's own `viewed/` for
        // the page to show from there, so it goes with the session [D35, D290]. `at` is its file, or the copy once that's gone.
        "view" => {
            let asked = arg(args, 3)?;
            if owner == HOME_DRAFT {
                return Err(io::Error::other("This isn't an image to show."));
            }
            let path = named(data, owner, asked);
            let at = path.as_ref().filter(|p| p.is_file());
            let Some(name) = Path::new(asked)
                .file_name()
                .filter(|n| is_image(n.as_ref()) || svg(n.as_ref()))
            else {
                return Ok(json!({"ok": false, "error": "This isn't an image to show.", "at": at}));
            };
            // By the path as asked, so a copy is found with its checkout gone too.
            let id = format!("v{:016x}", {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                Path::new(asked).hash(&mut h);
                h.finish()
            });
            let viewed = core::session_dir(data, owner).join("viewed");
            let file = viewed.join(&id).join(name);
            // Opened without waiting: a pipe named as an image would hold the read.
            let open = |p| {
                let mut options = fs::OpenOptions::new();
                let from = options.read(true).custom_flags(libc::O_NONBLOCK).open(p)?;
                Ok((from.metadata()?, from))
            };
            match path.as_ref().map(open) {
                Some(Ok((meta, _))) if meta.is_file() && meta.len() > MAX_BYTES => {
                    let mut reply = too_large();
                    reply["at"] = json!(at);
                    return Ok(reply);
                }
                // Copied again on each open, the agent may have changed it since; whole before it takes the old one's place.
                Some(Ok((meta, mut from))) if meta.is_file() => {
                    fs::create_dir_all(viewed.join(&id))?;
                    let tmp = viewed.join(adapters::uuid());
                    fs::File::create(&tmp)
                        .and_then(|mut to| io::copy(&mut from, &mut to))
                        .and_then(|_| fs::rename(&tmp, &file))
                        .inspect_err(|_| drop(fs::remove_file(&tmp)))?;
                }
                // Its file gone (a worker's folder goes with it), its copy shows.
                _ if file.exists() => {}
                Some(Err(e)) => return Err(e),
                _ => return Err(io::ErrorKind::NotFound.into()),
            }
            Ok(json!({"ok": true, "id": id, "at": at.unwrap_or(&file)}))
        }
        // A file or folder a thread's link names outside the checkout shows in Finder, as the old app's [D2098, D290].
        // An attachment by its id (an image the agent made) shows its file [D300].
        "reveal" => {
            let path = arg(args, 3)?;
            let kept = (!path.starts_with('/') && core::check_id(path).is_ok())
                .then(|| {
                    fs::read_dir(core::message::sent(&core::session_dir(data, owner)).join(path))
                        .ok()
                })
                .flatten()
                .and_then(|mut found| Some(found.next()?.ok()?.path().display().to_string()));
            let path = kept.as_deref().unwrap_or(path);
            if !path.starts_with('/')
                || !std::process::Command::new("open")
                    .arg("-R")
                    .arg(path)
                    .status()?
                    .success()
            {
                return Err(io::Error::other(format!("Couldn't reveal {path}")));
            }
            Ok(json!({"ok": true}))
        }
        // The files the owner holds, oldest first: its draft's again after a restart, and a session's
        // sent ones for its card [D363, D1274].
        "list" => {
            let mut folders = vec![(folder.clone(), false)];
            let mut labels = std::collections::HashMap::new();
            if owner != HOME_DRAFT {
                let dir = core::session_dir(data, owner);
                // A sent image or paste is named as its message's text had it, "Image #2", "Pasted text #1",
                // its numbers restarting per message, as the old card [D2098].
                core::rewind::read_active(&dir, |item| {
                    if item["kind"] != "input" {
                        return;
                    }
                    let mut count = (0, 0);
                    for chip in item["parts"]["parts"].as_array().into_iter().flatten() {
                        let Some(id) = chip["attachmentId"].as_str() else {
                            continue;
                        };
                        let label = match chip["kind"].as_str() {
                            Some("image") => {
                                count.0 += 1;
                                format!("Image #{}", count.0)
                            }
                            // One of a name of its own goes by it: a PR's "Merge conflicts – PR #7" [D171].
                            Some("paste") => match file_in(&sent(&dir), id)
                                .and_then(|f| Some(f.file_stem()?.to_string_lossy().into_owned()))
                                .filter(|stem| stem != "Pasted text")
                            {
                                Some(stem) => stem,
                                None => {
                                    count.1 += 1;
                                    format!("Pasted text #{}", count.1)
                                }
                            },
                            _ => continue,
                        };
                        labels.entry(id.to_string()).or_insert(label);
                    }
                })?;
                folders.push((sent(&dir), true));
            }
            let mut files: Vec<(std::time::SystemTime, Value)> = vec![];
            for (at, is_sent) in folders {
                for entry in fs::read_dir(&at).into_iter().flatten().flatten() {
                    let id = entry.file_name().to_string_lossy().to_string();
                    let Some(file) = file_in(&at, &id) else {
                        continue;
                    };
                    // A sent note's text as it was then, kept for the message alone.
                    if id.starts_with(message::notes::KEPT) && !is_image(&file) {
                        continue;
                    }
                    let when = entry
                        .metadata()
                        .and_then(|m| m.modified())
                        .unwrap_or(std::time::UNIX_EPOCH);
                    let name = file
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    let label = labels.get(&id);
                    files.push((when, json!({"id": id, "name": name, "label": label, "mime": message::mime(&file), "path": file, "sent": is_sent})));
                }
            }
            files.sort_by_key(|(at, _)| *at);
            Ok(json!({"ok": true, "files": files.into_iter().map(|(_, f)| f).collect::<Vec<_>>()}))
        }
        _ => Err(io::Error::other(crate::USAGE)),
    }
}

/// Not one every agent takes (`is_image`), but the page draws it.
fn svg(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("svg"))
}

/// Where an image's path, as a message writes it, is on disk: whole or under `~/`, anywhere; else inside the session's
/// checkout, never out of it, where a bare name is found as its refs find it [D251].
fn named(data: &Path, owner: &str, asked: &str) -> Option<PathBuf> {
    if asked.starts_with('/') {
        return Some(asked.into());
    }
    if let Some(rest) = asked.strip_prefix("~/") {
        return Some(Path::new(&std::env::var_os("HOME")?).join(rest));
    }
    let asked = asked.trim_start_matches("./");
    let checkout = git::checkout(data, &Target::Session(owner)).ok()?;
    if let Some(at) = git::inside(&checkout, asked).ok().filter(|at| at.is_file()) {
        return Some(at);
    }
    let reply = crate::mention::paths(data, &json!({"owner": owner, "paths": [asked]}));
    reply["found"][asked]["at"].as_str().map(PathBuf::from)
}

/// What a start took from its draft goes back: its tabs, and its files copied, so a session that
/// can't go keeps its own.
pub fn back(data: &Path, spec: &core::Spec, parts: &Value, carried: bool) -> io::Result<()> {
    back_into(&message::home(data), data, spec, parts, carried)
}

/// The same, its files into `folder`: Home's, or a device's own [D51].
pub fn back_into(
    folder: &Path,
    data: &Path,
    spec: &core::Spec,
    parts: &Value,
    carried: bool,
) -> io::Result<()> {
    for id in message::ids(parts) {
        if let (Some(file), None) = (file_in(&sent(&spec.dir), &id), file_in(folder, &id)) {
            copy_whole(&file, &folder.join(&id))?;
        }
    }
    match carried {
        true => crate::tabs::back(data, spec),
        false => Ok(()),
    }
}

/// File `file` into draft folder entry `to`, whole or not at all: copied under another name, then
/// renamed, so a copy cut short is never taken for one done [C80]. One already there is replaced
/// once the new copy is whole; cut short between, the source is still there to copy again.
pub(crate) fn copy_whole(file: &Path, to: &Path) -> io::Result<()> {
    let name = to.file_name().unwrap_or_default().to_string_lossy();
    let part = to.with_file_name(format!(".{name}.part"));
    let _ = fs::remove_dir_all(&part);
    fs::create_dir_all(&part)?;
    fs::copy(file, part.join(file.file_name().unwrap_or_default()))?;
    book::crash_at("start:copying");
    if to.exists() {
        fs::remove_dir_all(to)?;
    }
    fs::rename(&part, to)
}

/// The old app's words for a file over the app's ceiling [D2022 #14].
fn too_large() -> Value {
    json!({"ok": false, "error": format!("File is too large to upload (maximum {} MB)", MAX_BYTES >> 20)})
}

/// Where draft `id`'s book is: a session's, or Home's, a file of its own for each project's draft
/// and Chats' (`@home:<p>`, `p` checked as an id); a deleted session refuses. A device's is its
/// slot's: `drafts/<device>` in the session's folder, `drafts/home-<device>[-<p>]` in Home's [D51].
pub fn place(data: &Path, id: &str, device: Option<&str>) -> io::Result<book::Place> {
    let file = match id.strip_prefix("@home:") {
        _ if id == HOME_DRAFT => "home-draft".into(),
        Some(p) => check_id(p).map(|()| format!("home-draft-{p}"))?,
        None => {
            let dir = core::load(data, id)?.dir;
            if device.is_some() {
                slot::made(&dir.join("drafts"))?;
            }
            return Ok(book::Place::Session(dir, device.map(String::from)));
        }
    };
    let file = match device {
        Some(d) => slot::made(&data.join("drafts"))?.join(file.replacen(
            "home-draft",
            &format!("home-{d}"),
            1,
        )),
        None => data.join(file),
    };
    let (data, device) = (data.to_path_buf(), device.map(String::from));
    Ok(book::Place::Home { data, file, device })
}

/// What the composer holds unsent, as the UI's own JSON [D109, D237], in its book (book.rs).
pub fn kept(data: &Path, args: &[String], device: Option<&str>) -> io::Result<Value> {
    let place = place(data, arg(args, 1)?, device)?;
    let mut reply = book::kept(&place, args)?;
    // New chat's draft of before each project had its own names the project it was in, read once.
    let old: Option<Value> = (args.len() == 2 && place.home().is_some())
        .then(|| serde_json::from_slice(&fs::read(place.file()).ok()?).ok())
        .flatten();
    if let Some(project) = old
        .filter(|v| v.get("book").is_none())
        .and_then(|v| v.get("project").cloned())
        && let Some(draft) = reply["draft"].as_str()
    {
        let mut draft: Value = serde_json::from_str(draft)?;
        draft["project"] = project;
        reply["draft"] = draft.to_string().into();
    }
    Ok(reply)
}

/// Home's files none of its saved drafts names, once a day old, as the old app's cleanup of files nothing refers to,
/// run as it did when a session is deleted; the day leaves undo and a send still on its way alone [D2098].
pub fn sweep_home(data: &Path) {
    let draft = |e: &fs::DirEntry| e.file_name().to_string_lossy().starts_with("home-draft");
    let drafts = fs::read_dir(data)
        .into_iter()
        .flatten()
        .flatten()
        .filter(draft);
    // A start on its way names its files only in its book's entry [C65].
    let named: Vec<String> = (drafts.filter_map(|e| fs::read_to_string(e.path()).ok()))
        .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
        .flat_map(|saved| {
            let going = saved["book"]["inflight"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            [saved]
                .into_iter()
                .chain(going)
                .flat_map(|each| message::ids(&each))
        })
        .collect();
    let day = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 60 * 60);
    let Ok(home) = draft_of(data, HOME_DRAFT) else {
        return;
    };
    for entry in fs::read_dir(home).into_iter().flatten().flatten() {
        let old = (entry.metadata().and_then(|m| m.modified())).is_ok_and(|at| at < day);
        if old && !named.iter().any(|n| entry.file_name() == n.as_str()) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    slot::sweep(data);
}
