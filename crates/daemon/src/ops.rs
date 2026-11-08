//! The daemon's op table: one connection's handshake, then each request routed by its op.

use super::watch::{self, Shown};
use super::{
    HANDSHAKE_TIMEOUT, PROTOCOL_VERSION, Shared, Sub, WRITE_TIMEOUT, publish, snapshot, term,
};
use brigadier::index;
use brigadier_core::check_id;
use brigadier_frames::wire;
use serde_json::{Value, json};
use std::io::{self, Read};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::{process, thread};

/// The commands the app runs: those that reach a host, and providers and onboarding [D45]. The
/// rest of the CLI prints to stdout or never returns.
const ROUTED: [&str; 21] = [
    "start",
    "seen",
    "rename",
    "pin",
    "unread",
    "send",
    "stop",
    "answer",
    "level",
    "recover",
    "delete",
    "terminal",
    "agents",
    "setup",
    "profile",
    "projects",
    "accounts",
    "switching",
    "switch",
    "models",
    "set",
];

pub(super) fn serve(
    mut stream: UnixStream,
    conn: u64,
    state: &Shared,
    data: &Path,
) -> io::Result<()> {
    if wire::peer_uid(&stream)? != unsafe { libc::geteuid() } {
        return Ok(());
    }
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    let mut version = [0; 4];
    stream.read_exact(&mut version)?;
    stream.set_read_timeout(None)?;
    let version = u32::from_be_bytes(version);
    if version != PROTOCOL_VERSION {
        let refused = json!({"status": "refused", "error": format!("protocol version mismatch: daemon speaks {PROTOCOL_VERSION}, client sent {version}"), "build": wire::build()});
        return wire::write_frame(&mut stream, &refused.to_string());
    }
    // One writer per connection, so replies and pushes never interleave and a slow client never
    // holds up the others.
    let (out, queue) = mpsc::channel::<String>();
    let mut writer = stream.try_clone()?;
    writer.set_write_timeout(Some(WRITE_TIMEOUT))?;
    thread::spawn(move || {
        for frame in queue {
            if wire::write_frame(&mut writer, &frame).is_err() {
                break;
            }
        }
        let _ = writer.shutdown(std::net::Shutdown::Both);
    });
    // Bumped to end this connection's thread watch: a new request, or the connection closing.
    let watching = Arc::new(AtomicU64::new(0));
    // The same for the terminal stream, and the bytes of it the app has drawn.
    let (terming, acked) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
    // The thread this connection watches, by session, for its older pages.
    let shown: Shown = Arc::default();
    let hello = json!({"status": "running", "pid": process::id(), "version": env!("CARGO_PKG_VERSION"), "build": wire::build()});
    let _ = out.send(hello.to_string());
    while let Ok(text) = wire::read_frame(&mut stream) {
        let req: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let re = req["id"].clone();
        match req["op"].as_str().unwrap_or("") {
            "subscribe" => {
                let mut s = state.lock().unwrap();
                let ready = s.ready;
                if ready {
                    let _ = out.send(snapshot(&re, s.n, &s.rows, &s.projects));
                }
                let waiting = (!ready).then_some(re);
                s.subs.insert(
                    conn,
                    Sub {
                        out: out.clone(),
                        waiting,
                    },
                );
            }
            "thread" => {
                let id = req["session"].as_str().unwrap_or("").to_string();
                let title = state
                    .lock()
                    .unwrap()
                    .rows
                    .get(&id)
                    .map_or(Value::Null, |r| r["title"].clone());
                let mine = watching.fetch_add(1, Ordering::SeqCst) + 1;
                let (out, data) = (out.clone(), PathBuf::from(data));
                let (watching, shown) = (watching.clone(), shown.clone());
                thread::spawn(move || {
                    watch::watch(&data, &id, title, re, &out, mine, &watching, &shown)
                });
            }
            "thread_older" => {
                let id = req["session"].as_str().unwrap_or("");
                let before = req["before"].as_u64().unwrap_or(0);
                let thread = shown
                    .lock()
                    .unwrap()
                    .as_ref()
                    .filter(|(s, _)| s == id)
                    .map(|(_, t)| t.clone());
                // Sent under the thread's lock, so no update to a row in the page overtakes it.
                let locked = thread.as_ref().map(|t| t.lock().unwrap());
                let reply = match &locked {
                    Some(thread) => {
                        let mut page = thread.older(before);
                        page["re"] = re;
                        page["ok"] = true.into();
                        page
                    }
                    None => json!({"re": re, "ok": false, "error": "not_watching"}),
                };
                let _ = out.send(reply.to_string());
            }
            "terminal" => {
                let id = req["session"].as_str().unwrap_or("").to_string();
                let mine = terming.fetch_add(1, Ordering::SeqCst) + 1;
                let (out, data) = (out.clone(), PathBuf::from(data));
                let (terming, acked) = (terming.clone(), acked.clone());
                thread::spawn(move || term::watch(&data, &id, re, &out, mine, &terming, &acked));
            }
            "term_ack" => {
                acked.fetch_add(req["bytes"].as_u64().unwrap_or(0), Ordering::SeqCst);
            }
            // Answered in order on this connection, so keys never pass each other.
            "keys" | "resize" => {
                let id = req["session"].as_str().unwrap_or("");
                let mut call = req.clone();
                call.as_object_mut()
                    .map(|o| (o.remove("id"), o.remove("session")));
                let mut reply = match check_id(id) {
                    Ok(()) => brigadier::owner::call(data, id, call)
                        .unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()})),
                    Err(e) => json!({"ok": false, "error": e.to_string()}),
                };
                reply["re"] = re;
                let _ = out.send(reply.to_string());
            }
            "search" => {
                let q = req["q"].as_str().unwrap_or("");
                let reply = match index::search(data, q) {
                    Ok(ids) => json!({"re": re, "ok": true, "ids": ids}),
                    Err(e) => json!({"re": re, "ok": false, "error": e.to_string()}),
                };
                let _ = out.send(reply.to_string());
            }
            "run" => {
                let args: Vec<String> = req["args"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|a| a.as_str().map(String::from))
                    .collect();
                let (out, data, state) = (out.clone(), PathBuf::from(data), state.clone());
                // A start waits for its host to answer: never hold up this connection's reads.
                thread::spawn(move || {
                    let mut reply = match args.first() {
                        Some(cmd) if ROUTED.contains(&cmd.as_str()) => brigadier::run(&data, &args)
                            .unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()})),
                        _ => json!({"ok": false, "error": format!("not routed: {args:?}")}),
                    };
                    // A project change goes out before its reply, so the app's pending row can
                    // leave as the reply lands [D30]. Before the first pass, that pass sends it.
                    let ready = state.lock().unwrap().ready;
                    if ready && args.first().is_some_and(|c| c == "projects") {
                        publish(&state, &data, vec![], vec![]);
                    }
                    reply["re"] = re;
                    let _ = out.send(reply.to_string());
                });
            }
            other => {
                let error =
                    json!({"re": re, "ok": false, "error": format!("unknown op {other:?}")});
                let _ = out.send(error.to_string());
            }
        }
    }
    watching.fetch_add(1, Ordering::SeqCst);
    terming.fetch_add(1, Ordering::SeqCst);
    state.lock().unwrap().subs.remove(&conn);
    Ok(())
}
