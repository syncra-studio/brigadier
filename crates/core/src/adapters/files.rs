//! Reading and trimming the files a CLI keeps for itself.

use serde_json::Value;
use std::path::Path;

/// Whole lines of a file after byte `from`, and the offset after the last one. A file not there
/// yet reads as empty, and one that shrank starts over.
pub fn file_lines(path: &Path, from: u64) -> (Vec<String>, u64) {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else {
        return (vec![], from);
    };
    let len = file.metadata().map_or(0, |m| m.len());
    let from = if len < from { 0 } else { from };
    let mut rest = Vec::new();
    if file.seek(SeekFrom::Start(from)).is_err() || file.read_to_end(&mut rest).is_err() {
        return (vec![], from);
    }
    let end = rest.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let lines = String::from_utf8_lossy(&rest[..end])
        .lines()
        .map(String::from)
        .collect();
    (lines, from + end as u64)
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
