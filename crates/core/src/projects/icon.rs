//! A project's own icon, picked in its settings: initials on one of the sidebar's tile colours
//! (`tag:<0-9>`), an emoji (`emoji:<it>`), or an image copied into the project's folder
//! (`image:<file>`). None: the folder's logo, else its initials on their own colour.

use super::{Project, change, dir, err, find};
use brigadier_frames::log::now_ms;
use std::fs;
use std::io;
use std::path::Path;

/// The sidebar's tile colours (app/ui sidebar/row.tsx TAGS).
const TAGS: u32 = 10;
/// Proposed: an icon image is at most this big.
const IMAGE_BYTES: u64 = 5 << 20;
const IMAGE_KINDS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

/// Sets `id`'s icon from `value`: "" (back to the folder's), `tag:<n>`, `emoji:<it>`, or
/// `image:<path>`, whose file is copied in; the image it had before goes.
pub fn set(data: &Path, id: &str, value: &str) -> io::Result<Project> {
    // A project that exists, so its folder's path is one of ours.
    super::get(data, id)?;
    let (icon, copied) = match value.split_once(':') {
        None if value.is_empty() => (None, None),
        Some(("tag", n)) if n.parse::<u32>().is_ok_and(|n| n < TAGS) => (Some(value.into()), None),
        Some(("emoji", e))
            if !e.is_empty() && e.len() <= 32 && !e.chars().any(char::is_whitespace) =>
        {
            (Some(value.into()), None)
        }
        Some(("image", path)) => {
            let name = copy(data, id, Path::new(path))?;
            (Some(format!("image:{name}")), Some(name))
        }
        _ => return err(format!("\"{value}\" isn't an icon.")),
    };
    let done = change(data, |list| {
        let p = find(list, id)?;
        Ok((std::mem::replace(&mut p.icon, icon), p.clone()))
    });
    // The image it no longer shows: the old one once saved, else the new copy.
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

/// Copies a picked image into the project's folder as `icon-<ms>.<kind>`: a new name each time,
/// so the window never shows the one it had cached.
fn copy(data: &Path, id: &str, from: &Path) -> io::Result<String> {
    let kind = from
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    let Some(kind) = kind.filter(|k| IMAGE_KINDS.contains(&k.as_str())) else {
        return err(format!(
            "{} isn't a PNG, JPEG, GIF, WebP or SVG image.",
            from.display()
        ));
    };
    let size = fs::metadata(from)?.len();
    if size > IMAGE_BYTES {
        return err(format!(
            "{} is over {} MB.",
            from.display(),
            IMAGE_BYTES >> 20
        ));
    }
    let name = format!("icon-{}.{kind}", now_ms());
    fs::create_dir_all(dir(data, id))?;
    fs::copy(from, dir(data, id).join(&name))?;
    Ok(name)
}
