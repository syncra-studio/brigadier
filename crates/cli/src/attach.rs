//! `attach <@home|id> add <aid> <name> --backend B (--path P | --data BASE64) | remove <aid> | list`
//! and `draft <@home|id> [<json>|""]`: the composer's files and its unsent draft, kept by Rust
//! under the session's folder, or Home's until Send makes its session [D35, D127, D363, D2022].

use super::{HOME_DRAFT, arg, flag, remove};
use brigadier_core::message::{self, MAX_BYTES, draft_of, file_in, is_image, sent};
use brigadier_core::{self as core, adapters, check_id};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
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
        // Taken out of the message: its file goes [D127].
        "remove" => {
            let id = arg(args, 3)?;
            check_id(id)?;
            match fs::remove_dir_all(folder.join(id)) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
                _ => Ok(json!({"ok": true})),
            }
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
                for turn in core::fold(&dir, true)
                    .map(|f| f.fold.turns)
                    .unwrap_or_default()
                {
                    let mut count = (0, 0);
                    for chip in turn.parts["parts"].as_array().into_iter().flatten() {
                        let Some(id) = chip["attachmentId"].as_str() else {
                            continue;
                        };
                        let label = match chip["kind"].as_str() {
                            Some("image") => {
                                count.0 += 1;
                                format!("Image #{}", count.0)
                            }
                            Some("paste") => {
                                count.1 += 1;
                                format!("Pasted text #{}", count.1)
                            }
                            _ => continue,
                        };
                        labels.entry(id.to_string()).or_insert(label);
                    }
                }
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
    let path = if id == HOME_DRAFT {
        data.join("home-draft")
    } else {
        core::load(data, id)?;
        core::session_dir(data, id).join("draft")
    };
    let saved = match args.get(2).map(String::as_str) {
        None => return Ok(json!({"ok": true, "draft": fs::read_to_string(&path).ok()})),
        Some("") => {
            remove(&path)?;
            Value::Null
        }
        Some(parts) => {
            core::write_atomic(&path, parts.as_bytes())?;
            serde_json::from_str(parts).unwrap_or_default()
        }
    };
    // Home's files its draft no longer names go once a day old, as the old app's cleanup of files nothing
    // refers to, at the next draft written: never at a send's emptying, whose take may still be on its way [D2098].
    if id == HOME_DRAFT && !saved.is_null() {
        let named = message::ids(&saved);
        let day = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 60 * 60);
        for entry in fs::read_dir(draft_of(data, id)?)
            .into_iter()
            .flatten()
            .flatten()
        {
            let old = (entry.metadata().and_then(|m| m.modified())).is_ok_and(|at| at < day);
            if old && !named.iter().any(|n| entry.file_name() == n.as_str()) {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(json!({"ok": true}))
}

/// 8000 as "8,000".
fn grouped(n: u32) -> String {
    match n {
        0..1000 => n.to_string(),
        _ => format!("{},{:03}", grouped(n / 1000), n % 1000),
    }
}
