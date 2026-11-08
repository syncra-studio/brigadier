//! A sign-in's terminal for the app [D45]. `{"id", "op": "terminal", "session"}` answers
//! `{"re", "ok", "found"}`, then pushes the run's last terminal from its spawn frame, and follows on:
//! `{"term", "watch", "start": {spawn, cols, rows}}` when a terminal starts, `{…, "data"}` (its
//! bytes, base64), `{…, "resize": {cols, rows}}` and `{…, "exited": true}`. Replayed whole, every
//! resize in its place, so the screen comes back the same [D60].
//!
//! Flow control: no more than WINDOW bytes go out before the app acks them with
//! `{"op": "term_ack", "bytes"}` once xterm has drawn them. Unread bytes wait in the log.

use brigadier_core::{check_id, session_dir};
use brigadier_frames::base64;
use brigadier_frames::log::{self, Reader};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::thread;
use std::time::Duration;

const WINDOW: u64 = 512 * 1024;
/// The most bytes one push carries.
const CHUNK: usize = 64 * 1024;
const FOLLOW: Duration = Duration::from_millis(30);

/// Where the last terminal's spawn frame is (offset, seq), or the log's end when it never had one.
fn last_start(log: &Path) -> io::Result<(u64, u64, bool)> {
    let Ok(mut r) = Reader::open(log, 0, 0) else {
        return Ok((0, 0, false));
    };
    let mut at = None;
    while let Some(f) = r.next_with(|k| k == log::SPAWNED)? {
        if f.kind == log::SPAWNED
            && serde_json::from_slice::<Value>(&f.data).is_ok_and(|v| v["mode"] == "pty")
        {
            at = Some((f.offset, f.seq));
        }
    }
    Ok(at.map_or((r.pos, r.seq, false), |(o, s)| (o, s, true)))
}

/// Streams the session's terminal until `watching` moves past `mine`.
pub fn watch(
    data: &Path,
    id: &str,
    re: Value,
    out: &Sender<String>,
    mine: u64,
    watching: &AtomicU64,
    acked: &AtomicU64,
) {
    let dir = session_dir(data, id);
    let log_path = dir.join("log");
    let start = if check_id(id).is_err() || !dir.join("session.json").exists() {
        Err(io::Error::other("not_found"))
    } else {
        last_start(&log_path)
    };
    let from = match start {
        Ok(at) => at,
        Err(e) => {
            let _ = out.send(json!({"re": re, "ok": false, "error": e.to_string()}).to_string());
            return;
        }
    };
    if out
        .send(json!({"re": re, "ok": true, "found": from.2}).to_string())
        .is_err()
    {
        return;
    }
    let push = |mut frame: Value| {
        frame["term"] = id.into();
        frame["watch"] = re.clone();
        out.send(frame.to_string()).is_ok()
    };
    let inode = |path: &Path| fs::metadata(path).map(|m| m.ino()).ok();
    let opened = inode(&log_path);
    let mut reader: Option<Reader> = None;
    let (mut pid, mut spawn) = (None, None);
    let mut sent = acked.load(Ordering::SeqCst);
    let mut bytes = vec![];
    loop {
        if watching.load(Ordering::SeqCst) != mine {
            return;
        }
        if !dir.join("session.json").exists() {
            push(json!({"error": "not_found"}));
            return;
        }
        if opened.is_some() && inode(&log_path) != opened {
            push(json!({"reset": true}));
            return;
        }
        if reader.is_none() && log_path.exists() {
            match Reader::open(&log_path, from.0, from.1) {
                Ok(r) => reader = Some(r),
                Err(e) => {
                    push(json!({"error": e.to_string()}));
                    return;
                }
            }
        }
        // The app hasn't drawn what it has yet: leave the rest in the log for now.
        if sent.saturating_sub(acked.load(Ordering::SeqCst)) > WINDOW {
            thread::sleep(FOLLOW);
            continue;
        }
        let mut idle = true;
        while bytes.len() < CHUNK {
            let Some(r) = reader.as_mut() else { break };
            let frame = match r
                .next_with(|k| matches!(k, log::PTY | log::SPAWNED | log::EXITED | log::NOTE))
            {
                Ok(Some(f)) => f,
                Ok(None) => break,
                Err(e) => {
                    push(json!({"error": e.to_string()}));
                    return;
                }
            };
            idle = false;
            if frame.kind == log::PTY {
                bytes.extend_from_slice(&frame.data);
                continue;
            }
            let v: Value = serde_json::from_slice(&frame.data).unwrap_or_default();
            let event = match frame.kind {
                log::SPAWNED if v["mode"] == "pty" => {
                    (pid, spawn) = (v["pid"].as_i64(), Some(frame.seq));
                    json!({"start": {"spawn": frame.seq, "cols": v["cols"], "rows": v["rows"]}})
                }
                log::EXITED if pid.is_some() && v["pid"].as_i64() == pid => {
                    pid = None;
                    json!({"exited": true})
                }
                log::NOTE
                    if v["event"] == "resize"
                        && spawn.is_some()
                        && v["spawn"].as_u64() == spawn =>
                {
                    json!({"resize": {"cols": v["cols"], "rows": v["rows"]}})
                }
                _ => continue,
            };
            // Bytes before an event go first, so the screen changes in log order.
            if !flush(&push, &mut bytes, &mut sent) || !push(event) {
                return;
            }
        }
        if !flush(&push, &mut bytes, &mut sent) {
            return;
        }
        if idle {
            thread::sleep(FOLLOW);
        }
    }
}

fn flush(push: &impl Fn(Value) -> bool, bytes: &mut Vec<u8>, sent: &mut u64) -> bool {
    if bytes.is_empty() {
        return true;
    }
    *sent += bytes.len() as u64;
    let ok = push(json!({"data": base64(bytes)}));
    bytes.clear();
    ok
}
