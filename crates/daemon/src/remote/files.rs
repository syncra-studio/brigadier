//! `attachment {owner, attachment, offset}`: a file's bytes to the phone over the channel, in
//! pieces (remote design §4.4; msgs/w40-outline.md §R2 1) [beat-competitors D51]. Served: a
//! visible session's sent `attachments/` and `viewed/` images, and this device's own unsent files
//! (`drafts/<device>-attachments/` in the session, or in the data folder for its Home drafts,
//! `owner: "@home"`). Never the Mac's own drafts, and never through a link.

use super::allow::{Ctx, REFUSED};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const PIECE: u64 = 256 << 10;
/// `MAX_BYTES` (`crates/core/src/message.rs`).
const MOST: u64 = 10 << 20;

pub(super) fn attachment(cx: &Ctx, req: &Value) -> Value {
    let allowed = ["id", "op", "owner", "attachment", "offset"];
    let fields = req.as_object().into_iter().flat_map(|m| m.keys());
    if fields.into_iter().any(|k| !allowed.contains(&k.as_str())) {
        return json!({"ok": false, "error": REFUSED});
    }
    let (owner, id) = (
        req["owner"].as_str().unwrap_or(""),
        req["attachment"].as_str().unwrap_or(""),
    );
    let offset = req["offset"].as_u64().unwrap_or(0);
    let mine = format!("{}-attachments", cx.device);
    let Ok(data) = fs::canonicalize(cx.data) else {
        return json!({"ok": false, "error": "not_found"});
    };
    let folders: Vec<PathBuf> = match owner {
        "@home" => vec![data.join("drafts").join(&mine)],
        id if cx.visible(id).is_ok() => {
            let dir = data.join("sessions").join(id);
            vec![
                dir.join("attachments"),
                dir.join("viewed"),
                dir.join("drafts").join(&mine),
            ]
        }
        _ => return json!({"ok": false, "error": REFUSED}),
    };
    let found = (folders.iter())
        .filter_map(|f| brigadier_core::message::file_in(f, id))
        .find(|p| unlinked(&data, p));
    let Some(path) = found else {
        return json!({"ok": false, "error": "not_found"});
    };
    match piece(&path, offset) {
        Ok((size, bytes)) => {
            json!({"ok": true, "name": path.file_name().map(|n| n.to_string_lossy()),
            "size": size, "offset": offset, "data": B64.encode(&bytes),
            "done": offset + bytes.len() as u64 >= size})
        }
        Err(e) => json!({"ok": false, "error": e.to_string()}),
    }
}

/// A plain file with no link anywhere from the data folder down to it, so a link put in a session's
/// folders never leads to the Mac's own drafts.
// shortcut: checked, then opened; a link swapped in between is followed. Open by fd walk if an agent's writes there matter.
fn unlinked(data: &Path, path: &Path) -> bool {
    let Ok(below) = path.strip_prefix(data) else {
        return false;
    };
    let mut at = data.to_path_buf();
    below.components().all(|c| {
        at.push(c);
        fs::symlink_metadata(&at).is_ok_and(|m| !m.file_type().is_symlink())
    }) && fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
}

fn piece(path: &PathBuf, offset: u64) -> std::io::Result<(u64, Vec<u8>)> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    if size > MOST {
        return Err(std::io::Error::other("too large"));
    }
    file.seek(SeekFrom::Start(offset.min(size)))?;
    let mut bytes = vec![];
    file.take(PIECE).read_to_end(&mut bytes)?;
    Ok((size, bytes))
}
