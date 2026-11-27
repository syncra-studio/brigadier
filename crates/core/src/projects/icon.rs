//! A project's own icon, picked in its settings: initials on one of the sidebar's tile colours
//! (`tag:<0-9>`), an emoji (`emoji:<it>`), or an image copied into the project's folder
//! (`image:<file>`). None: the folder's logo, else its initials on their own colour.

use super::{dir, err};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// The sidebar's tile colours (app/ui sidebar/row.tsx TAGS).
const TAGS: u32 = 10;
/// Proposed: an icon image is at most this big.
const IMAGE_BYTES: u64 = 5 << 20;
const IMAGE_KINDS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

/// Checks `value`, "" (back to the folder's), `tag:<n>`, `emoji:<it>` or `image:<path>`, and
/// copies an image in: the icon to save, and the copy to drop should the save fail.
pub(super) fn checked(
    data: &Path,
    id: &str,
    value: &str,
) -> io::Result<(Option<String>, Option<String>)> {
    Ok(match value.split_once(':') {
        None if value.is_empty() => (None, None),
        Some(("tag", n)) if n.parse::<u32>().is_ok_and(|n| n < TAGS) => (Some(value.into()), None),
        Some(("emoji", e)) if one_emoji(e) => (Some(value.into()), None),
        Some(("image", path)) => {
            let name = copy(data, id, Path::new(path))?;
            (Some(format!("image:{name}")), Some(name))
        }
        _ => return err(format!("\"{value}\" isn't an icon.")),
    })
}

/// After the save: the image it no longer shows goes, the old one once saved, else the new copy
/// and the folder it made.
pub(super) fn tidy(data: &Path, id: &str, saved: Option<Option<String>>, copied: Option<String>) {
    let failed = saved.is_none() && copied.is_some();
    let gone = match saved {
        Some(old) => old.and_then(|old| old.strip_prefix("image:").map(String::from)),
        None => copied,
    };
    if let Some(name) = gone {
        let _ = fs::remove_file(dir(data, id).join(name));
    }
    if failed {
        // Only when empty: the folder may hold the project's other images.
        let _ = fs::remove_dir(dir(data, id));
    }
}

/// Whether `e` is one emoji, as near as a check without Unicode's tables gets: one base character,
/// with its modifiers, selectors and keycap, others joined to it by ZWJ, or a flag's two letters.
fn one_emoji(e: &str) -> bool {
    let (mut bases, mut joined, mut letters) = (0, false, 0);
    for c in e.chars() {
        match c {
            '\u{200d}' => joined = true,
            '\u{fe0e}'
            | '\u{fe0f}'
            | '\u{20e3}'
            | '\u{1f3fb}'..='\u{1f3ff}'
            | '\u{e0020}'..='\u{e007f}' => {}
            '\u{1f1e6}'..='\u{1f1ff}' => {
                letters += 1;
                bases += usize::from(letters == 1);
            }
            _ if c.is_whitespace() || c.is_control() => return false,
            _ => {
                bases += usize::from(!joined);
                joined = false;
            }
        }
    }
    // A family with its skin tones is 11 characters.
    bases == 1 && letters <= 2 && e.chars().count() <= 11
}

/// Copies a picked image into the project's folder as `icon-<ns>-<n>.<kind>`: a new name each
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
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    #[cfg(windows)]
    std::os::windows::fs::OpenOptionsExt::custom_flags(
        &mut options,
        windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT,
    );
    options
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
    // Nanoseconds, so a name a set in the same instant just freed isn't taken again.
    let ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    for n in 0.. {
        let (name, to) = (format!("icon-{ns}-{n}.{kind}"), dir(data, id));
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
    // shortcut: a doctype's internal subset (entities) is refused, real icons have none.
    let open = rest
        .strip_prefix("<svg")
        .and_then(|r| r.chars().next())
        .is_some_and(|c| c.is_whitespace() || c == '>' || c == '/');
    // Whole, not cut off: closed, or the root closes itself.
    open && (rest.contains("</svg>") || rest.trim_end().ends_with("/>"))
}
