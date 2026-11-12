//! Reading and trimming the files a CLI keeps for itself.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// The skills a CLI keeps as `<folder>/<name>/SKILL.md`, each named with its folder's prefix (a
/// plugin's `plugin:`), by name once, the first folder's first [D100].
pub fn skills_in(folders: impl IntoIterator<Item = (PathBuf, String)>) -> Vec<Value> {
    let mut list: Vec<Value> = vec![];
    for (folder, prefix) in folders {
        let mut found: Vec<(String, PathBuf)> = (std::fs::read_dir(&folder).into_iter().flatten())
            .flatten()
            .map(|e| {
                (
                    e.file_name().to_string_lossy().to_string(),
                    e.path().join("SKILL.md"),
                )
            })
            .filter(|(_, path)| path.is_file())
            .collect();
        found.sort();
        for (name, path) in found {
            let name = format!("{prefix}{name}");
            if !list.iter().any(|l| l["name"] == *name) {
                list.push(json!({"name": name, "description": "", "kind": "skill", "path": path, "instant": false}));
            }
        }
    }
    list
}

/// A random UUID (v4), for a conversation id the CLI lets us pick.
pub fn uuid() -> String {
    let mut b = [0u8; 16];
    let _ = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut b));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

/// Removes the lines of a CLI's shared JSON-lines file whose `key` is `id` [D35]. Other lines,
/// also ones the CLI appends meanwhile, stay: the swap happens only if the file didn't change
/// since it was read, else it reads again.
pub fn drop_lines(path: &Path, key: &str, id: &str) -> std::io::Result<usize> {
    for _ in 0..20 {
        let (before, perms) = match std::fs::metadata(path) {
            Ok(m) => ((m.len(), m.modified()?), m.permissions()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e),
        };
        let text = std::fs::read(path)?;
        let mine = |l: &[u8]| serde_json::from_slice::<Value>(l).is_ok_and(|v| v[key] == id);
        let lines: Vec<&[u8]> = text.split_inclusive(|&b| b == b'\n').collect();
        let gone = lines.iter().filter(|l| mine(l)).count();
        if gone == 0 {
            return Ok(0);
        }
        let kept: Vec<u8> = lines
            .into_iter()
            .filter(|l| !mine(l))
            .flatten()
            .copied()
            .collect();
        // Its own name per call, so two deletes at once never write the same temp file.
        let tmp = path.with_extension(format!("brigadier-{}", uuid()));
        std::fs::write(&tmp, kept)?;
        std::fs::set_permissions(&tmp, perms)?;
        let now = std::fs::metadata(path)?;
        // shortcut: an append landing between this check and the rename is lost; a lock the CLIs
        // share would close that, if they ever publish one.
        if (now.len(), now.modified()?) == before {
            std::fs::rename(&tmp, path)?;
            return Ok(gone);
        }
        std::fs::remove_file(&tmp)?;
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Err(std::io::Error::other(format!(
        "{} kept changing",
        path.display()
    )))
}

/// One changed file in the thread's FileChange shape [D74, D83]: what the CLI didn't report is null.
pub fn change(
    path: &str,
    change: &str,
    diff: Option<String>,
    added: Option<u64>,
    removed: Option<u64>,
) -> Value {
    let diff = diff.map(|d| hunks(&d)).filter(|d| !d.is_empty());
    serde_json::json!({"path": path, "change": change, "from": null, "diff": diff, "added": added, "removed": removed})
}

/// A unified diff's hunks alone: the file headers (`Index:`, `===`, `---`, `+++`) dropped.
fn hunks(diff: &str) -> String {
    let mut hunk = false;
    let mut out = String::new();
    for line in diff.lines() {
        if line.starts_with("@@") {
            hunk = true;
        } else if line.starts_with("diff ") || line.starts_with("Index: ") {
            hunk = false;
        }
        if hunk {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Lines added and removed in a unified diff: only lines inside hunks, so file headers don't count
/// and a `+++counter` line does.
pub fn counts(diff: &str) -> (u64, u64) {
    let (mut added, mut removed, mut hunk) = (0, 0, false);
    for line in diff.lines() {
        if line.starts_with("@@") {
            hunk = true;
        } else if line.starts_with("diff ") || line.starts_with("Index: ") {
            hunk = false;
        } else if hunk && line.starts_with('+') {
            added += 1;
        } else if hunk && line.starts_with('-') {
            removed += 1;
        }
    }
    (added, removed)
}

/// SHA-1 in hex (FIPS 180-4), for a CLI that names a folder by the hash of a path.
pub fn sha1(data: &[u8]) -> String {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut m = data.to_vec();
    m.push(0x80);
    while m.len() % 64 != 56 {
        m.push(0);
    }
    m.extend((data.len() as u64 * 8).to_be_bytes());
    for block in m.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..80 {
            w[i] = match i {
                0..16 => u32::from_be_bytes(block[4 * i..4 * i + 4].try_into().unwrap()),
                _ => (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1),
            };
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..20 => ((b & c) | (!b & d), 0x5A827999),
                20..40 => (b ^ c ^ d, 0x6ED9EBA1),
                40..60 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let t = (a.rotate_left(5))
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            (e, d, c, b, a) = (d, c, b.rotate_left(30), a, t);
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e]) {
            *x = x.wrapping_add(y);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}
