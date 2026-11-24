//! A note's images: kept beside it in `<note>.images/`, named in its Markdown as
//! `![alt](<note>.images/<name>)`, and only those are ever read. A message that mentions a note keeps
//! the note and its images as they were then, so a later edit never changes what was sent.

use super::{CHAT_BYTES, MAX_BYTES, MAX_FILES, file_in, is_image, kind, mime, sent, size};
use crate::adapters::{self, Adapter};
use crate::{Spec, check_id, data_of, session_dir};
use serde_json::{Value, json};
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io;
use std::ops::Range;
use std::path::{Path, PathBuf};

/// What starts the id of a file kept of a sent note.
pub const KEPT: &str = "note-";

/// The folder of a note's images, beside its file.
pub fn folder(note: &Path) -> PathBuf {
    note.with_extension("images")
}

/// One image in a note's Markdown: where, its alt text, the note its path names and its file's name.
pub struct Found {
    pub at: Range<usize>,
    pub alt: String,
    pub note: String,
    pub name: String,
}

/// A name kept as it is in a path: no folder, no hidden file.
pub fn plain_name(name: &str) -> bool {
    !name.starts_with('.') && !name.contains(['/', '\\', '\0']) && is_image(Path::new(name))
}

/// Every image of a note in `text`, in order; none inside code. The page reads the same form (app/ui/src/note/image.tsx).
pub fn find(text: &str) -> Vec<Found> {
    let mut found = vec![];
    let mut fence: Option<(u8, usize)> = None;
    let mut start = 0;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim();
        let mark = trimmed.bytes().next().filter(|b| matches!(b, b'`' | b'~'));
        let ticks = mark.map_or(0, |m| trimmed.bytes().take_while(|b| *b == m).count());
        match (fence, mark) {
            (Some((m, n)), _) => {
                if mark == Some(m) && ticks >= n && trimmed.len() == ticks {
                    fence = None;
                }
            }
            (None, Some(m)) if ticks >= 3 && !(m == b'`' && trimmed[ticks..].contains('`')) => {
                fence = Some((m, ticks));
            }
            _ => in_line(line, start, &mut found),
        }
        start += line.len();
    }
    found
}

fn in_line(line: &str, start: usize, found: &mut Vec<Found>) {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            // A span of inline code, to its closing run of as many ticks.
            b'`' => {
                let run = b[i..].iter().take_while(|c| **c == b'`').count();
                let ticks = &line[i..i + run];
                let close = line[i + run..].match_indices(ticks).find(|(at, _)| {
                    let (a, z) = (i + run + at, i + run + at + run);
                    b[a - 1] != b'`' && b.get(z) != Some(&b'`')
                });
                i += run + close.map_or(0, |(at, _)| at + run);
            }
            b'\\' => i += 2,
            b'!' if b.get(i + 1) == Some(&b'[') => match image(line, i) {
                Some((end, alt, note, name)) => {
                    let at = start + i..start + end;
                    found.push(Found {
                        at,
                        alt,
                        note,
                        name,
                    });
                    i = end;
                }
                None => i += 1,
            },
            _ => i += 1,
        }
    }
}

/// The image at `from` in `line`: where it ends, its alt, its note and its name.
fn image(line: &str, from: usize) -> Option<(usize, String, String, String)> {
    let (mut alt, mut i) = (String::new(), from + 2);
    let mut chars = line[i..].chars();
    loop {
        let c = chars.next()?;
        i += c.len_utf8();
        match c {
            ']' => break,
            '[' => return None,
            '\\' => {
                let next = chars.next()?;
                i += next.len_utf8();
                if !next.is_ascii_punctuation() {
                    alt.push('\\');
                }
                alt.push(next);
            }
            _ => alt.push(c),
        }
    }
    let inside = line[i..].strip_prefix('(')?;
    // Its path, in `<>` where it holds spaces, then a title, which is kept as written.
    let (dest, rest) = match inside.strip_prefix('<') {
        Some(angled) => angled.split_once('>').filter(|(d, _)| !d.contains('<'))?,
        None => inside.split_at(inside.find([' ', '\t', '(', ')'])?),
    };
    let len = rest.find(['(', ')'])?;
    if rest.as_bytes()[len] != b')' {
        return None;
    }
    let title = rest[..len].trim();
    let quoted = title.len() > 1 && title.starts_with('"') && title.ends_with('"');
    if !title.is_empty() && !(quoted && rest.starts_with([' ', '\t'])) {
        return None;
    }
    let end = line.len() - rest.len() + len + 1;
    let (note, name) = dest
        .strip_prefix("./")
        .unwrap_or(dest)
        .split_once(".images/")?;
    let name = unescaped(name)?;
    (check_id(note).is_ok() && plain_name(&name)).then(|| (end, alt, note.to_string(), name))
}

/// A URL path's `%20`s as the characters they are.
fn unescaped(name: &str) -> Option<String> {
    let (b, mut out, mut i) = (name.as_bytes(), vec![], 0);
    while i < b.len() {
        if b[i] == b'%' {
            out.push(u8::from_str_radix(name.get(i + 1..i + 3)?, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A note's own image: its file, only a real one inside the note's own images folder.
pub fn file(note: &Path, id: &str, name: &str) -> Option<PathBuf> {
    if note.file_stem()?.to_str()? != id {
        return None;
    }
    let dir = folder(note);
    let file = dir.join(name);
    let real = |p: &Path| fs::symlink_metadata(p).is_ok_and(|m| !m.is_symlink());
    (real(&dir) && real(&file) && file.is_file()).then_some(file)
}

/// Where a note is: its project's notes or the shared ones, then where one still waits to move, as
/// its list shows it [D922].
fn located(data: &Path, id: &str) -> Option<(PathBuf, String)> {
    check_id(id).ok()?;
    let projects = (fs::read_dir(data.join("projects"))
        .into_iter()
        .flatten()
        .flatten())
    .map(|e| e.path().join("notes"));
    let waiting = (crate::ids(data).into_iter())
        .map(|s| session_dir(data, &s).join("notes"))
        .chain([data.join("home-notes")]);
    (projects.chain([data.join("notes")]).chain(waiting))
        .map(|dir| dir.join(format!("{id}.md")))
        .find_map(|path| fs::read_to_string(&path).ok().map(|text| (path, text)))
}

fn hashed(bytes: &[u8]) -> String {
    let mut hash = DefaultHasher::new();
    bytes.hash(&mut hash);
    format!("{KEPT}{:016x}", hash.finish())
}

/// Keeps `bytes` as `name` under the session's sent files, once; its id there.
fn keep(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<String> {
    let id = hashed(bytes);
    if file_in(&sent(dir), &id).is_none() {
        fs::create_dir_all(sent(dir).join(&id))?;
        crate::write_atomic(&sent(dir).join(&id).join(name), bytes)?;
    }
    Ok(id)
}

/// The ids of what a message keeps of its notes: each note's text, then its images.
pub fn kept(parts: &Value) -> Vec<String> {
    let mut ids: Vec<String> = vec![];
    for part in parts["parts"].as_array().into_iter().flatten() {
        let images = (part["kept"]["images"].as_object().into_iter().flatten()).map(|(_, id)| id);
        for id in [&part["kept"]["text"]].into_iter().chain(images) {
            let id = id.as_str().map(String::from);
            ids.extend(id.filter(|id| !ids.contains(id)));
        }
    }
    ids
}

/// A sent message's files under `sent`, its own, then each note as it was with its images in order.
pub fn files(parts: &Value) -> Vec<String> {
    let own = (parts["files"].as_array().into_iter().flatten()).filter_map(|f| {
        let (id, name) = (f["id"].as_str()?, f["name"].as_str()?);
        (!id.starts_with(KEPT)).then(|| format!("{id}/{name}"))
    });
    let mut all: Vec<String> = own.collect();
    for part in parts["parts"].as_array().into_iter().flatten() {
        let (label, kept) = (part["label"].as_str().unwrap_or(""), &part["kept"]);
        if let (Some(id), Some(text)) = (part["id"].as_str(), kept["text"].as_str()) {
            all.push(format!(
                "{text}/{id}.md, the note \"{label}\" as it was sent"
            ));
        }
        for (n, (name, id)) in (kept["images"].as_object().into_iter().flatten()).enumerate() {
            let id = id.as_str().unwrap_or("");
            all.push(format!("{id}, image {} of that note, {name}", n + 1));
        }
    }
    all
}

/// Keeps each note `parts` mentions, with its images, under session `dir` as it is now, named in its
/// chip's `kept`: what's sent now, queued, put back or sent again later is that. One already kept stays.
pub fn freeze(data: &Path, dir: &Path, parts: &mut Value) -> io::Result<()> {
    let chips = parts.get_mut("parts").and_then(Value::as_array_mut);
    for part in chips.into_iter().flatten() {
        let held = |id: &str| file_in(&sent(dir), id).is_some();
        if part["kind"] != "mention"
            || part["type"] != "note"
            || part["kept"]["text"].as_str().is_some_and(held)
        {
            continue;
        }
        let id = part["id"].as_str().unwrap_or("").to_string();
        let Some((path, mut text)) = located(data, &id) else {
            continue;
        };
        if text.len() > CHAT_BYTES {
            let (all, mut at) = (find(&text), CHAT_BYTES);
            // Never through an image's own Markdown.
            if let Some(cut) = all.iter().find(|f| f.at.contains(&at)) {
                at = cut.at.start;
            }
            while !text.is_char_boundary(at) {
                at -= 1;
            }
            text.truncate(at);
            let left = all.iter().filter(|f| f.at.start >= at).count();
            text += &match left {
                0 => "\n[…cut; read the rest in the file]".to_string(),
                n => format!(
                    "\n[…cut, with {n} of its images not sent; read the rest in the file, its images in {}]",
                    folder(&path).display()
                ),
            };
        }
        let mut images = serde_json::Map::new();
        for found in find(&text) {
            if images.len() >= MAX_FILES || images.contains_key(&found.name) {
                continue;
            }
            let Some(file) = file(&path, &found.note, &found.name) else {
                continue;
            };
            if fs::metadata(&file).is_ok_and(|m| m.len() <= MAX_BYTES)
                && let Ok(bytes) = fs::read(&file)
                && size(&bytes).is_some()
                && let Some(kind) = kind(&bytes)
            {
                // One misnamed goes as the kind it is, or its agent refuses the whole message.
                let name = match mime(&file) == kind {
                    true => found.name.clone(),
                    false => format!("{}.{}", found.name, &kind["image/".len()..]),
                };
                images.insert(found.name.clone(), keep(dir, &name, &bytes)?.into());
            }
        }
        let text = keep(dir, &format!("{id}.md"), text.as_bytes())?;
        part["kept"] = json!({"path": path, "text": text, "images": images});
    }
    Ok(())
}

/// A message's files taken into session `dir` (`take`) and its notes kept, as one queued there.
pub fn taken(data: &Path, dir: &Path, mut parts: Value, from: Option<&str>) -> io::Result<Value> {
    super::take(data, dir, &parts, from)?;
    freeze(data, dir, &mut parts)?;
    Ok(parts)
}

/// A mentioned note as the agent reads it: its text as kept, each image's number and path after it,
/// the image added to `images`, as far as `most` in all; one that can't go says why.
pub(super) fn told(
    spec: &Spec,
    to: &Takes,
    part: &Value,
    images: &mut Vec<PathBuf>,
    most: usize,
) -> String {
    let title = part["label"].as_str().unwrap_or("");
    let (id, kept) = (part["id"].as_str().unwrap_or(""), &part["kept"]);
    let gone = || format!("[mentions the note \"{title}\", which is gone]");
    let of = |id: &Value| file_in(&sent(&spec.dir), id.as_str()?);
    let Some(text) = of(&kept["text"]).and_then(|p| fs::read_to_string(p).ok()) else {
        return gone();
    };
    let path = kept["path"].as_str().unwrap_or("");
    let (mut out, mut done) = (String::new(), 0);
    for found in find(&text) {
        out += &text[done..found.at.end];
        done = found.at.end;
        let live = || folder(Path::new(path)).join(&found.name);
        // Another note's image isn't this one's to send.
        if found.note != id {
            out += " [Image not sent: it's not one of this note's own]";
            continue;
        }
        let Some(file) = of(&kept["images"][&found.name]) else {
            out += &match kept["images"]
                .as_object()
                .is_some_and(|i| i.len() >= MAX_FILES)
            {
                true => format!(
                    " [Image not sent, at most {MAX_FILES} attachments go with a message: {}]",
                    live().display()
                ),
                false => format!(
                    " [Image not sent, its file can't be read: {}]",
                    live().display()
                ),
            };
            continue;
        };
        let n = match images.iter().position(|i| *i == file) {
            Some(at) => Ok(at + 1),
            None => match to.refuses(&file) {
                Some(why) => Err(why),
                None if images.len() >= most => {
                    Err(format!("at most {MAX_FILES} attachments go with a message"))
                }
                None => {
                    images.push(file.clone());
                    Ok(images.len())
                }
            },
        };
        out += &match n {
            Ok(n) => format!(" [Image #{n}: {}]", file.display()),
            Err(why) => format!(" [Image not sent, {why}: {}]", file.display()),
        };
    }
    out += &text[done..];
    let numbered = match done {
        0 => "",
        _ => ", each of its images numbered where it is",
    };
    format!(
        "[mentions the note \"{title}\" ({path}; change it there only if asked); its text follows{numbered}]\n{out}\n[/note]"
    )
}

/// What a note's side chat reads first: the note it's beside, and the checkout it may read.
pub fn lead(note: &str, reads: Option<&str>) -> String {
    let checkout = reads.map_or(String::new(), |r| {
        format!(" To build it from the project, read the session's checkout at {r}; change nothing there.")
    });
    let images = folder(Path::new(note));
    let (id, images) = (
        (images.file_stem().unwrap_or_default()).to_string_lossy(),
        images.display(),
    );
    format!(
        "[This chat is beside the user's note {note}, in the same window. When the user asks, write or change that note by editing the file in place: a first line `# ` names it if the user renamed it (an emoji may lead it; keep that line as it is), then a blank line, then its body; without that line its first line of text names it. The body is Markdown (headings, lists, `- [ ]` checklists, tables, quotes, code, images as `![alt]({id}.images/<name>)`). Its images are in {images}; put a new one there. Change no other file.{checkout}]"
    )
}

/// The agent and model a message goes to, as far as its images ask: `backend` if named, else the
/// pick its next turn takes, else the one it runs on.
pub struct Takes {
    agent: Option<&'static dyn Adapter>,
    images: bool,
}

impl Takes {
    pub(super) fn of(spec: &Spec, backend: Option<&str>) -> io::Result<Self> {
        let f = crate::fold(&spec.dir, true)?.fold;
        let picked = (f.picked.as_ref()).filter(|_| backend.is_none() && f.turns.is_empty());
        let name = backend
            .or(picked.map(|p| p.backend.as_str()))
            .or(Some(f.backend.as_str()).filter(|b| !b.is_empty()))
            .unwrap_or(&spec.backend);
        let model = match picked {
            Some(p) => Some(p.model.clone()),
            None => crate::as_run(spec, &f, name, None).model,
        };
        // As its CLI's list last said, in any folder it was checked in.
        let checks: Value = fs::read(data_of(spec).join(format!("agents/{name}.json")))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let blind = (checks.as_object().into_iter().flatten())
            .flat_map(|(_, check)| check["models"].as_array().into_iter().flatten())
            .any(|m| m["images"] == false && model.as_deref().is_some_and(|id| m["id"] == id));
        Ok(Takes {
            agent: adapters::get(name),
            images: !blind,
        })
    }

    /// Why this image can't go; None when it can.
    fn refuses(&self, file: &Path) -> Option<String> {
        if !self.images {
            return Some("this model doesn't take images".into());
        }
        refused(self.agent?, &fs::read(file).ok()?)
    }
}

/// Why `a`'s agent can't take this image, by its own known limits; None when it can [D487, D492].
pub fn refused(a: &dyn Adapter, bytes: &[u8]) -> Option<String> {
    let (most, side) = a.image_limits();
    if most.is_some_and(|m| bytes.len() as u64 > m) {
        return Some(format!(
            "{} takes images up to {} MB",
            a.label(),
            most? >> 20
        ));
    }
    let (w, h) = size(bytes)?;
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

/// 8000 as "8,000".
fn grouped(n: u32) -> String {
    match n {
        0..1000 => n.to_string(),
        _ => format!("{},{:03}", grouped(n / 1000), n % 1000),
    }
}
