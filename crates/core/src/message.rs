//! A message as the composer sends it: its text with its chips in place, and the files it carries
//! [D109, D127]. Rust keeps each file under its session's folder and builds what the agent reads:
//! an image in the agent's own form, any other file as its path, a long paste whole, a mention as
//! the old app's line [D2007, D2008, D2021].

use crate::{Spec, check_id, data_of, session_dir};
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The app-wide ceiling, as the old app's [D2022 #14].
pub const MAX_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_FILES: usize = 20;
/// What a mentioned session carries, newest first, as the old app's [D2021].
const CHAT_MESSAGES: usize = 30;
const CHAT_BYTES: usize = 24_000;
/// The image kinds every agent takes, as the old app's.
const IMAGES: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

/// One message: `text` as the thread shows it, `parts` the composer's draft (Null for plain text),
/// `agent` what the agent reads, `images` the images going with it, `commands` the agent's own
/// commands its chips name.
#[derive(Clone, Default)]
pub struct Message {
    pub text: String,
    pub parts: Value,
    pub agent: String,
    pub images: Vec<PathBuf>,
    pub commands: Vec<Value>,
}

impl Message {
    pub fn plain(text: &str) -> Self {
        Message {
            text: text.into(),
            agent: text.into(),
            ..Default::default()
        }
    }
}

/// Home's draft files, until Send makes their session [D2022 #18].
pub fn home(data: &Path) -> PathBuf {
    data.join("home-draft-attachments")
}

/// A session's sent files, and those of its draft not sent yet.
pub fn sent(dir: &Path) -> PathBuf {
    dir.join("attachments")
}
pub fn draft(dir: &Path) -> PathBuf {
    dir.join("draft-attachments")
}

/// Where an owner's (`@home` or a session's) unsent files go.
pub fn draft_of(data: &Path, owner: &str) -> io::Result<PathBuf> {
    if owner == "@home" {
        return Ok(home(data));
    }
    check_id(owner)?;
    Ok(draft(&session_dir(data, owner)))
}

/// The one file in `folder/<id>/`.
pub fn file_in(folder: &Path, id: &str) -> Option<PathBuf> {
    check_id(id).ok()?;
    let entry = fs::read_dir(folder.join(id)).ok()?.flatten().next()?;
    Some(entry.path())
}

pub fn is_image(path: &Path) -> bool {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    IMAGES.contains(&ext.to_ascii_lowercase().as_str())
}

/// Every attachment id a draft names: its tiles and its in-text images and pastes.
pub fn ids(parts: &Value) -> Vec<String> {
    let chips = (parts["parts"].as_array().into_iter().flatten())
        .filter_map(|p| p["attachmentId"].as_str());
    let tiles = (parts["attachmentIds"].as_array().into_iter().flatten()).filter_map(Value::as_str);
    let mut ids: Vec<String> = vec![];
    for id in chips.chain(tiles) {
        if !ids.iter().any(|i| i == id) {
            ids.push(id.into());
        }
    }
    ids
}

/// Takes the files `parts` names into session `dir`'s `attachments/`: its own draft's and Home's
/// are moved, `from`'s (a message sent as new from there) copied, so deleting that session leaves
/// this one whole [D35, D204, D2022 #18]. A file never stored (a failed attach) is skipped.
pub fn take(data: &Path, dir: &Path, parts: &Value, from: Option<&str>) -> io::Result<()> {
    let ids = ids(parts);
    if ids.len() > MAX_FILES {
        return Err(io::Error::other(format!(
            "at most {MAX_FILES} attachments per message"
        )));
    }
    let mut from_home = false;
    for id in ids {
        if file_in(&sent(dir), &id).is_some() {
            continue;
        }
        let to = sent(dir).join(&id);
        let homes = file_in(&home(data), &id);
        from_home |= homes.is_some();
        if let Some(file) = file_in(&draft(dir), &id).or(homes) {
            fs::create_dir_all(sent(dir))?;
            fs::rename(file.parent().unwrap(), &to)?;
        } else if let Some(file) = from.and_then(|s| {
            let at = session_dir(data, s);
            file_in(&sent(&at), &id).or_else(|| file_in(&draft(&at), &id))
        }) {
            fs::create_dir_all(&to)?;
            fs::copy(&file, to.join(file.file_name().unwrap()))?;
        }
    }
    // Home's draft became this session: what it held and didn't send goes with it [D2022 #18].
    // A draft emptied without a send keeps its files until a session's delete finds them a day old (cli
    // attach.rs `sweep_home`); a tile's ✕ removes its own at once.
    if from_home {
        let _ = fs::remove_file(data.join("home-draft"));
        let _ = fs::remove_dir_all(home(data));
    }
    Ok(())
}

/// The message as its agent reads it, its files already taken into `spec`'s session: a long
/// paste whole where it was pasted, an image as "[Image #n]" with the image beside, each other
/// file and each mention as the old app's line after the text [D2007, D2008, D2021].
pub fn compose(spec: &Spec, text: &str, parts: Value) -> io::Result<Message> {
    if parts.is_null() {
        return Ok(Message::plain(text));
    }
    let data = data_of(spec);
    let (mut agent, mut notes, mut images) = (String::new(), vec![], vec![]);
    let file = |id: &str| file_in(&sent(&spec.dir), id);
    for part in parts["parts"].as_array().into_iter().flatten() {
        let label = part["label"].as_str().unwrap_or("");
        match (part["kind"].as_str(), part["type"].as_str()) {
            (None, _) => agent += part.as_str().unwrap_or(""),
            (Some("mention"), Some("chat")) => {
                agent += label;
                notes.push(conversation(
                    &data,
                    part["id"].as_str().unwrap_or(""),
                    label,
                ));
            }
            // By its id, which its `brigadier` commands take, as the old app's `[mentions task-N: title]`.
            (Some("mention"), Some("worker")) => {
                agent += label;
                let id = part["id"].as_str().unwrap_or("");
                notes.push(format!("[mentions worker {id}: {label}]"));
            }
            // Handed to the agent with the message: the app gave it the tab as it sent [D775]. Only a
            // tab of this session's own is given; to another (a worker, a new session) it's named.
            (Some("mention"), Some("tab")) => {
                agent += label;
                let id = part["id"].as_str().unwrap_or("");
                let tabs: Value = fs::read(spec.dir.join("tabs.json"))
                    .ok()
                    .and_then(|b| serde_json::from_slice(&b).ok())
                    .unwrap_or_default();
                let mut own = tabs["tabs"].as_array().into_iter().flatten();
                match own.any(|t| t["id"] == id) {
                    true => notes.push(format!("[gives you browser tab {id} ({label}): it's yours to use now, with the user's sign-ins. `brigadier browser snapshot --tab {id}` reads it.]")),
                    false => notes.push(format!("[mentions the browser page {label}]")),
                }
            }
            (Some("mention"), Some(kind)) => {
                agent += label;
                notes.push(format!("[mentions the {kind} {label}]"));
            }
            (Some("image"), _) => {
                if let Some(path) = file(part["attachmentId"].as_str().unwrap_or("")) {
                    images.push(path);
                    agent += &format!("[Image #{}]", images.len());
                }
            }
            (Some("paste"), _) => {
                if let Some(path) = file(part["attachmentId"].as_str().unwrap_or("")) {
                    agent += &fs::read_to_string(path)?;
                }
            }
            _ => agent += label,
        }
    }
    for id in (parts["attachmentIds"].as_array().into_iter().flatten()).filter_map(Value::as_str) {
        match file(id) {
            Some(path) if is_image(&path) => images.push(path),
            Some(path) => {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                notes.push(format!(
                    "[Attached file \"{name}\" ({}): {}]",
                    mime(&path),
                    path.display()
                ));
            }
            None => {}
        }
    }
    for note in notes {
        agent += "\n";
        agent += &note;
    }
    // The sent bubble's files, by name and kind, so the thread shows them without reading the folder.
    // A paste went into the text whole; it shows as the old app's "Pasted text" card.
    let pasted = |id: &str| {
        (parts["parts"].as_array().into_iter().flatten())
            .any(|p| p["kind"] == "paste" && p["attachmentId"] == id)
    };
    let files: Vec<Value> = (ids(&parts).iter())
        .filter_map(|id| file(id).map(|path| (id, path)))
        .map(|(id, path)| {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            let bytes = fs::metadata(&path).map_or(0, |m| m.len());
            serde_json::json!({"id": id, "name": name, "mime": mime(&path), "bytes": bytes, "pasted": pasted(id)})
        })
        .collect();
    let commands = commands(spec, &parts)?;
    let mut parts = parts;
    parts["files"] = files.into();
    Ok(Message {
        text: text.into(),
        parts,
        agent,
        images,
        commands,
    })
}

/// Each command chip as its agent last listed it, so its adapter can send it in the agent's own
/// form; one not listed keeps its name and kind [D164, D2009].
fn commands(spec: &Spec, parts: &Value) -> io::Result<Vec<Value>> {
    let chips: Vec<&Value> = (parts["parts"].as_array().into_iter().flatten())
        .filter(|p| p["kind"] == "command")
        .collect();
    if chips.is_empty() {
        return Ok(vec![]);
    }
    let f = crate::fold(&spec.dir, true)?.fold;
    let backend = if f.backend.is_empty() {
        &spec.backend
    } else {
        &f.backend
    };
    let listed = f.commands.get(backend).and_then(Value::as_array);
    Ok((chips.iter())
        .map(|c| {
            let id = c["id"].as_str().unwrap_or("");
            let (kind, name) = id.split_once(':').unwrap_or(("command", id));
            let found = listed
                .into_iter()
                .flatten()
                .find(|l| l["name"] == name && l["kind"] == kind);
            found
                .cloned()
                .unwrap_or_else(|| serde_json::json!({"name": name, "kind": kind, "path": null}))
        })
        .collect())
}

/// A mentioned session's latest messages, as the old app's: newest first until 30 or 24 kB, then
/// back in order [D2021].
fn conversation(data: &Path, id: &str, title: &str) -> String {
    let mut said: Vec<String> = vec![];
    if check_id(id).is_ok() {
        let _ = crate::rewind::read_active(&session_dir(data, id), |item| {
            let text = item["text"].as_str().unwrap_or("");
            match item["kind"].as_str() {
                Some("input") if item["origin"] != "system" => said.push(format!("User: {text}")),
                Some("text") => match said.last_mut() {
                    Some(last) if last.starts_with("Assistant: ") => *last += text,
                    _ => said.push(format!("Assistant: {text}")),
                },
                _ => {}
            }
        });
    }
    if said.is_empty() {
        return format!("[mentions the conversation \"{title}\", which has no messages]");
    }
    let (mut kept, mut bytes) = (vec![], 0);
    for m in said.iter().rev().take(CHAT_MESSAGES) {
        if bytes + m.len() > CHAT_BYTES && !kept.is_empty() {
            break;
        }
        bytes += m.len();
        kept.push(m.as_str());
    }
    kept.reverse();
    format!(
        "[mentions the conversation \"{title}\"; its latest messages follow]\n{}\n[/conversation]",
        kept.join("\n\n")
    )
}

/// A file's type by its name, for the agent's line and an image's form.
pub fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "html" => "text/html",
        _ => "application/octet-stream",
    }
}

/// An image's width and height from its header (PNG, JPEG, GIF, WebP); None when it can't say.
pub fn size(b: &[u8]) -> Option<(u32, u32)> {
    let be16 = |i: usize| Some(u16::from_be_bytes(b.get(i..i + 2)?.try_into().ok()?) as u32);
    let le16 = |i: usize| Some(u16::from_le_bytes(b.get(i..i + 2)?.try_into().ok()?) as u32);
    let be32 = |i: usize| Some(u32::from_be_bytes(b.get(i..i + 4)?.try_into().ok()?));
    if b.starts_with(b"\x89PNG") {
        return Some((be32(16)?, be32(20)?));
    }
    if b.starts_with(b"GIF8") {
        return Some((le16(6)?, le16(8)?));
    }
    if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        let le24 = |i: usize| Some(le16(i)? | (*b.get(i + 2)? as u32) << 16);
        return match b.get(12..16)? {
            b"VP8X" => Some((le24(24)? + 1, le24(27)? + 1)),
            b"VP8L" => {
                let n = u32::from_le_bytes(b.get(21..25)?.try_into().ok()?);
                Some(((n & 0x3fff) + 1, (n >> 14 & 0x3fff) + 1))
            }
            _ => Some((le16(26)? & 0x3fff, le16(28)? & 0x3fff)),
        };
    }
    if b.starts_with(&[0xff, 0xd8]) {
        let mut i = 2;
        while i + 9 < b.len() {
            let (marker, len) = (b[i + 1], be16(i + 2)? as usize);
            // A start-of-frame segment holds the size; the rest are skipped by their length.
            if matches!(marker, 0xc0..=0xcf) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
                return Some((be16(i + 7)?, be16(i + 5)?));
            }
            i += 2 + len;
        }
    }
    None
}
