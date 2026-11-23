//! Images an agent made, kept in its session's own folder as attachments are, so the thread shows
//! them, the viewer's Download saves them and a fork takes them, after the CLI's own copy is gone
//! [D289, D301]. Every adapter's helper keeps them here, provider-neutral.

use std::fs;
use std::io;
use std::path::Path;

/// An id the attachments endpoint takes: plain name characters only, at most 128.
pub fn plain(id: &str) -> String {
    let id: String = (id.chars())
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '_' | '-' => c,
            _ => '-',
        })
        .take(127)
        .collect();
    format!("i{id}")
}

/// Copies `from` into `dir`'s attachments under `id`; its name, which the copy keeps. A copy
/// already there stays as it is.
pub fn keep(dir: &Path, id: &str, from: &Path) -> io::Result<String> {
    let name = from.file_name().ok_or(io::ErrorKind::InvalidInput)?;
    let to = crate::message::sent(dir).join(id);
    if !to.join(name).exists() {
        fs::create_dir_all(&to)?;
        fs::copy(from, to.join(name))?;
    }
    Ok(name.to_string_lossy().into())
}

/// Standard base64, as a CLI's image bytes come; None when it isn't.
pub fn decode(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let bytes: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let body = bytes
        .strip_suffix(b"==")
        .or(bytes.strip_suffix(b"="))
        .unwrap_or(&bytes);
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for &c in body {
        acc = (acc << 6) | u32::from(value(c)?);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}
