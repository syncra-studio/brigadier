//! A project's own icon, picked in its settings: initials on one of the sidebar's tile colours
//! (`tag:<0-9>`), an emoji (`emoji:<it>`), or an image copied into the project's folder
//! (`image:<file>`). None: the folder's logo, else its initials on their own colour.

use super::{Change, Project, dir, err, find};
use brigadier_frames::log::now_ms;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

/// The sidebar's tile colours (app/ui sidebar/row.tsx TAGS).
const TAGS: u32 = 10;
/// Proposed: an icon image is at most this big.
const IMAGE_BYTES: u64 = 5 << 20;
const IMAGE_KINDS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

/// Changes `id`'s settings as `change` does, and its icon to `value` when given: "" (back to the
/// folder's), `tag:<n>`, `emoji:<it>`, or `image:<path>`, whose file is copied in. All is checked
/// before anything is saved; the image it had before goes once the new one is.
pub fn set(data: &Path, id: &str, value: Option<&str>, change: Change) -> io::Result<Project> {
    let Some(value) = value else {
        return super::set(data, id, change);
    };
    // A project that exists, so its folder's path is one of ours.
    super::get(data, id)?;
    let (icon, copied) = match value.split_once(':') {
        None if value.is_empty() => (None, None),
        Some(("tag", n)) if n.parse::<u32>().is_ok_and(|n| n < TAGS) => (Some(value.into()), None),
        // One emoji, a family or flag's few joined characters at most.
        Some(("emoji", e))
            if (1..=8).contains(&e.chars().count())
                && !e.chars().any(|c| c.is_whitespace() || c.is_control()) =>
        {
            (Some(value.into()), None)
        }
        Some(("image", path)) => {
            let name = copy(data, id, Path::new(path))?;
            (Some(format!("image:{name}")), Some(name))
        }
        _ => return err(format!("\"{value}\" isn't an icon.")),
    };
    // The rest is checked, then saved, and then the icon: a crash between leaves an orphan copy.
    let done = super::set(data, id, change).and_then(|_| {
        super::change(data, |list| {
            let p = find(list, id)?;
            Ok((std::mem::replace(&mut p.icon, icon), p.clone()))
        })
    });
    // The image it no longer shows, once the record is written: the old one, else the new copy.
    let gone = match &done {
        Ok((_, (old, _))) => old
            .as_deref()
            .and_then(|old| old.strip_prefix("image:"))
            .map(String::from),
        Err(_) => copied,
    };
    if let Some(name) = gone {
        let _ = fs::remove_file(dir(data, id).join(name));
    }
    done.map(|(_, (_, project))| project)
}

/// Copies a picked image into the project's folder as `icon-<ms>-<n>.<kind>`: a new name each
/// time, so the window never shows the one it had cached and no copy lands on another.
fn copy(data: &Path, id: &str, from: &Path) -> io::Result<String> {
    let kind = from
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    let not_image = || {
        err(format!(
            "{} isn't a PNG, JPEG, GIF, WebP or SVG image.",
            from.display()
        ))
    };
    let Some(kind) = kind.filter(|k| IMAGE_KINDS.contains(&k.as_str())) else {
        return not_image();
    };
    // A link could point anywhere readable, and the copy is served to the window.
    if !fs::symlink_metadata(from)?.is_file() {
        return err(format!("{} isn't a plain file.", from.display()));
    }
    let mut bytes = Vec::new();
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(from)?
        .take(IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > IMAGE_BYTES {
        return err(format!(
            "{} is over {} MB.",
            from.display(),
            IMAGE_BYTES >> 20
        ));
    }
    if !is(&kind, &bytes) {
        return not_image();
    }
    fs::create_dir_all(dir(data, id))?;
    let ms = now_ms();
    for n in 0.. {
        let (name, to) = (format!("icon-{ms}-{n}.{kind}"), dir(data, id));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(to.join(&name))
        {
            Ok(mut file) => {
                let written = file.write_all(&bytes);
                return written.map(|()| name.clone()).inspect_err(|_| {
                    let _ = fs::remove_file(to.join(&name));
                });
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

/// Whether `bytes` are the image their extension says: its magic bytes, an SVG's root element.
fn is(kind: &str, bytes: &[u8]) -> bool {
    match kind {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        "svg" => std::str::from_utf8(bytes).is_ok_and(svg),
        _ => false,
    }
}

/// Whether `text` is an SVG document: past its XML declaration, comments and doctype, `<svg`.
fn svg(text: &str) -> bool {
    let mut rest = text.trim_start_matches('\u{feff}').trim_start();
    while let Some(after) = rest.strip_prefix("<?").or_else(|| rest.strip_prefix("<!")) {
        let end = if after.starts_with("--") {
            after.find("-->").map(|i| i + 3)
        } else {
            after.find('>').map(|i| i + 1)
        };
        let Some(end) = end else { return false };
        rest = after[end..].trim_start();
    }
    rest.strip_prefix("<svg")
        .and_then(|r| r.chars().next())
        .is_some_and(|c| c.is_whitespace() || c == '>' || c == '/')
}
