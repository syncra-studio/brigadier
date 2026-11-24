//! A note's images, in `<note>.images/` beside it, so they go where it goes and when it goes. One
//! taken out of the text stays, as undo can bring it back: it goes a week later, when the note is
//! first opened in a run of the app, which holds no undo for it yet.

use super::{MAX_BYTES, locate};
use crate::flag;
use brigadier_core as core;
use brigadier_core::message::{self, notes};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const KEPT_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// `image <note> <name> (--path P | --data BASE64 | --from <note>/<name>)`: an image into the note
/// under the name the page gave it, read from disk, pasted, or another note's, copied with its node.
pub(super) fn add(
    data: &Path,
    dir: &Path,
    note: &Path,
    name: &str,
    args: &[String],
) -> io::Result<Value> {
    if !notes::plain_name(name) {
        return Err(io::Error::other("This image has no name to keep it by."));
    }
    let no = |why: String| Ok(json!({"ok": false, "error": why}));
    let large = || {
        no(format!(
            "Image is too large (maximum {} MB)",
            MAX_BYTES >> 20
        ))
    };
    let from = match (flag(args, "--path"), flag(args, "--from")) {
        (Some(path), _) => Some(PathBuf::from(path)),
        (None, Some(from)) => {
            let (other, name) =
                (from.split_once('/')).ok_or_else(|| io::Error::other(crate::USAGE))?;
            let at = locate(data, dir, other)?;
            let found = notes::plain_name(name).then(|| notes::file(&at, other, name));
            let Some(file) = found.flatten() else {
                return no("The note it was copied from no longer has it.".into());
            };
            Some(file)
        }
        (None, None) => None,
    };
    let bytes = match (from, flag(args, "--data")) {
        (Some(path), _) => {
            if fs::metadata(&path)?.len() > MAX_BYTES {
                return large();
            }
            fs::read(path)?
        }
        (None, Some(b64)) => brigadier_frames::unbase64(b64)
            .ok_or_else(|| io::Error::other("The image's bytes didn't arrive whole."))?,
        (None, None) => return Err(io::Error::other(crate::USAGE)),
    };
    if bytes.len() as u64 > MAX_BYTES {
        return large();
    }
    // By its bytes: a file only named as an image is refused.
    if message::size(&bytes).is_none() {
        return no("Notes take PNG, JPEG, GIF and WebP images.".into());
    }
    let folder = notes::folder(note);
    if fs::symlink_metadata(&folder).is_ok_and(|m| m.is_symlink()) {
        return Err(io::Error::other("This note's images folder is a link."));
    }
    fs::create_dir_all(&folder)?;
    core::write_atomic(&folder.join(name), &bytes)?;
    Ok(json!({"ok": true}))
}

/// Whole paths of the images a note's text shows, in order, each with its alt text.
pub(crate) fn shown(note: &Path, text: &str) -> Vec<(String, PathBuf)> {
    (notes::find(text).into_iter())
        .filter_map(|f| Some((f.alt.clone(), notes::file(note, &f.note, &f.name)?)))
        .collect()
}

fn named(note: &Path, text: &str) -> BTreeSet<PathBuf> {
    shown(note, text)
        .into_iter()
        .map(|(_, path)| path)
        .collect()
}

/// Images `now` no longer shows are kept a week from here.
pub(super) fn dropped(note: &Path, was: &str, now: &str) {
    for path in named(note, was).difference(&named(note, now)) {
        if let Ok(file) = fs::File::open(path) {
            let _ = file.set_modified(SystemTime::now());
        }
    }
}

/// Clears what a week has passed over: the note's images its text doesn't show, and those of notes
/// in its folder that are gone (emptied, or an image added to one never written).
pub(super) fn sweep(note: &Path, text: &str) {
    let old = |path: &Path| {
        (fs::metadata(path).and_then(|m| m.modified()).ok())
            .and_then(|at| at.elapsed().ok())
            .is_some_and(|d| d > KEPT_FOR)
    };
    let files = |dir: &Path| -> Vec<PathBuf> {
        (fs::read_dir(dir).into_iter().flatten().flatten())
            .map(|e| e.path())
            .collect()
    };
    let real = |p: &Path| fs::symlink_metadata(p).is_ok_and(|m| m.is_dir());
    let shown = named(note, text);
    let own = notes::folder(note);
    // A path there written in a form `find` doesn't read (a reference, HTML) keeps them all.
    let unread = text.matches(".images").count() > notes::find(text).len();
    if note.exists() && real(&own) && !unread {
        for path in files(&own) {
            if !shown.contains(&path) && old(&path) {
                let _ = fs::remove_file(path);
            }
        }
    }
    for dir in note.parent().map(files).unwrap_or_default() {
        let left = dir.extension().is_some_and(|e| e == "images")
            && dir != own
            && real(&dir)
            && !dir.with_extension("md").exists();
        if left && files(&dir).iter().all(|p| old(p)) {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

/// With its note: gone.
pub(super) fn remove(note: &Path) -> io::Result<()> {
    let folder = notes::folder(note);
    let gone = match fs::symlink_metadata(&folder).is_ok_and(|m| m.is_symlink()) {
        true => fs::remove_file(&folder),
        false => fs::remove_dir_all(&folder),
    };
    match gone {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// A note's Markdown with `old`'s images read as `new`'s: the same note under another id.
pub(super) fn renamed(text: &str, old: &str, new: &str) -> String {
    let mut out = text.to_string();
    for found in notes::find(text).into_iter().rev() {
        if found.note == old {
            let whole = &text[found.at.clone()];
            let path = whole.rfind(&format!("{old}.images/")).unwrap_or(0);
            let at = found.at.start + path;
            out.replace_range(at..at + old.len(), new);
        }
    }
    out
}

/// Keep both: `note`'s own copy of every image its text has from `--from`, and the text naming them.
pub(super) fn copied(note: &Path, from: &Path, text: &str) -> io::Result<String> {
    let id = |p: &Path| {
        p.file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    };
    let folder = notes::folder(note);
    for path in named(from, text) {
        fs::create_dir_all(&folder)?;
        fs::copy(&path, folder.join(path.file_name().unwrap()))?;
    }
    Ok(renamed(text, &id(from), &id(note)))
}

/// A note's text as words: each image as its alt text, or nothing.
pub(super) fn words(text: &str, alt: bool) -> String {
    let (mut out, mut done) = (String::new(), 0);
    for found in notes::find(text) {
        out += &text[done..found.at.start];
        if alt {
            out += &found.alt;
        }
        done = found.at.end;
    }
    out + &text[done..]
}

/// What names a note that holds only images: the first's alt text.
pub(super) fn name(text: &str) -> Option<String> {
    let first = notes::find(text).into_iter().next()?;
    Some(match first.alt.trim() {
        "" => "Image".into(),
        alt => alt.into(),
    })
}
