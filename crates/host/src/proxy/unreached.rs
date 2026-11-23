//! The servers whose last connect (`server/discover` or `initialize`, then `tools/list`) didn't get
//! a result, in `plugins/unreached.json`: a CLI that fails one at its start never dials it again,
//! so the next message asks it to.

use serde_json::Value;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

/// One write at a time: each request runs on its own thread.
static FILE: Mutex<()> = Mutex::new(());

/// What a CLI's connect to a server sends, newest protocol first: a failed listing leaves it
/// connected with no tools.
const CONNECTS: [&str; 3] = ["server/discover", "initialize", "tools/list"];

/// Whether a reply's start (`head`, its first bytes) is a JSON-RPC result, not an error: an
/// error comes as HTTP 200 too. The envelope's `result` sits before any tool's own fields.
pub(super) fn answered(head: &[u8]) -> bool {
    head.windows(8).any(|w| w == b"\"result\"")
}

/// Notes `name` down (`down`) or answering again, when `body` is part of a CLI's connect.
pub(super) fn note(dir: &Path, name: &str, body: &[u8], down: bool) {
    // Most bodies aren't one: they aren't parsed.
    let has = |m: &str| body.windows(m.len()).any(|w| w == m.as_bytes());
    if !CONNECTS.iter().any(|m| has(m)) {
        return;
    }
    let msg: Value = serde_json::from_slice(body).unwrap_or_default();
    if !CONNECTS.iter().any(|m| msg["method"] == *m) {
        return;
    }
    let _one = FILE.lock().unwrap();
    let file = dir.join("plugins").join("unreached.json");
    let mut names: Vec<String> = fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    names.retain(|n| n != name);
    if down {
        names.push(name.into());
    }
    let tmp = file.with_extension("tmp");
    if fs::write(&tmp, serde_json::to_vec(&names).unwrap_or_default()).is_ok() {
        let _ = fs::rename(tmp, file);
    }
}
