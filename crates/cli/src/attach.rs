//! `attach <@home|id> add <aid> <name> --backend B (--path P | --data BASE64) | read <aid> | write <aid> <text> | remove <aid> | list | back <session> <parts JSON or null> [--carry-tabs] | view <path> | reveal <path>`
//! and `draft <@home|id> [<json>|""]`: the composer's files and its unsent draft, kept by Rust
//! under the session's folder, or Home's until Send makes its session [D35, D127, D363, D2022]; and
//! `note`, the session's notes (note.rs).

pub(crate) mod note;

use super::{HOME_DRAFT, arg, flag, has, remove};
use brigadier_core::message::{self, MAX_BYTES, draft_of, file_in, is_image, sent};
use brigadier_core::{self as core, adapters, check_id};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    if args[0] == "note" {
        return note::run(data, args);
    }
    let owner = arg(args, 1)?;
    if owner != HOME_DRAFT {
        core::load(data, owner)?;
    }
    let folder = draft_of(data, owner)?;
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
                    .and_then(|a| refused(a, &bytes))
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
            match fs::remove_dir_all(folder.join(id)) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
                _ => Ok(json!({"ok": true})),
            }
        }
        // A start that's discarded: its session, if made, goes next.
        "back" if owner == HOME_DRAFT => {
            let id = arg(args, 3)?;
            check_id(id)?;
            if core::session_dir(data, id).join("session.json").exists() {
                let parts = serde_json::from_str(arg(args, 4)?)?;
                let carried = has(args, "--carry-tabs");
                back(data, &core::load(data, id)?, &parts, carried)?;
            }
            Ok(json!({"ok": true}))
        }
        // An image a thread's link names, anywhere on disk, copied under the session's own `viewed/` for
        // the image viewer to show from there, so it goes with the session [D35, D290].
        "view" => {
            let path = Path::new(arg(args, 3)?);
            let name = path
                .file_name()
                .filter(|_| path.is_absolute() && is_image(path));
            let (Some(name), false) = (name, owner == HOME_DRAFT) else {
                return Err(io::Error::other("This isn't an image to show."));
            };
            if fs::metadata(path)?.len() > MAX_BYTES {
                return Ok(too_large());
            }
            let id = format!("v{:016x}", {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                path.hash(&mut h);
                h.finish()
            });
            let file = core::session_dir(data, owner)
                .join("viewed")
                .join(&id)
                .join(name);
            fs::create_dir_all(file.parent().unwrap())?;
            // Copied again on each open: the agent may have changed it since.
            fs::copy(path, &file)?;
            Ok(json!({"ok": true, "id": id}))
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
                            // One of a name of its own goes by it: a PR sent to the agent's "Pull request #7" [D699].
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

/// What a start took from its draft goes back: its tabs, and its files copied, so a session that
/// can't go keeps its own.
pub fn back(data: &Path, spec: &core::Spec, parts: &Value, carried: bool) -> io::Result<()> {
    let folder = message::home(data);
    for id in message::ids(parts) {
        if let (Some(file), None) = (file_in(&sent(&spec.dir), &id), file_in(&folder, &id)) {
            let to = folder.join(&id);
            fs::create_dir_all(&to)?;
            fs::copy(&file, to.join(file.file_name().unwrap()))?;
        }
    }
    match carried {
        true => crate::tabs::back(data, spec),
        false => Ok(()),
    }
}

/// The old app's words for a file over the app's ceiling [D2022 #14].
fn too_large() -> Value {
    json!({"ok": false, "error": format!("File is too large to upload (maximum {} MB)", MAX_BYTES >> 20)})
}

/// Why `a`'s agent can't take this image, by its own known limits; None when it can [D487, D492].
fn refused(a: &dyn adapters::Adapter, bytes: &[u8]) -> Option<String> {
    let (most, side) = a.image_limits();
    if most.is_some_and(|m| bytes.len() as u64 > m) {
        return Some(format!(
            "{} takes images up to {} MB",
            a.label(),
            most? >> 20
        ));
    }
    let (w, h) = message::size(bytes)?;
    side.filter(|s| w.max(h) > *s).map(|s| {
        format!(
            "{} takes images up to {} pixels a side; this one is {} × {}",
            a.label(),
            grouped(s),
            grouped(w),
            grouped(h)
        )
    })
}

/// What the composer holds unsent, as the UI's own JSON [D109, D237]; a deleted session refuses.
pub fn kept(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    // Each project's draft keeps its words, and Chats' its own; `p` was checked in lib.rs.
    let path = if id == HOME_DRAFT {
        data.join("home-draft")
    } else if let Some(p) = id.strip_prefix("@home:") {
        data.join(format!("home-draft-{p}"))
    } else {
        core::load(data, id)?;
        core::session_dir(data, id).join("draft")
    };
    match args.get(2).map(String::as_str) {
        None => return Ok(json!({"ok": true, "draft": fs::read_to_string(&path).ok()})),
        Some("") => remove(&path)?,
        Some(parts) => core::write_atomic(&path, parts.as_bytes())?,
    }
    Ok(json!({"ok": true}))
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
    let named: Vec<String> = (drafts.filter_map(|e| fs::read_to_string(e.path()).ok()))
        .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
        .flat_map(|saved| message::ids(&saved))
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
}

/// 8000 as "8,000".
fn grouped(n: u32) -> String {
    match n {
        0..1000 => n.to_string(),
        _ => format!("{},{:03}", grouped(n / 1000), n % 1000),
    }
}
