//! `brigadierd`: the app's one way to every host [D40, D60]. It keeps the session list from the
//! logs (`index.db`, off the write path [D67]), sweeps what dead hosts left running, and routes the
//! app's commands to the hosts. Killing it leaves every host working: they never depend on it.
//!
//! Its protocol is its own (the hosts keep theirs): the 4-byte version, a hello, then JSON frames.
//! `{"id", "op": "subscribe"}` answers `{"re", "n", "rows"}`, the list at N, and then pushes
//! `{"n": N+1, "rows", "gone"}`, `{"n": N+2, …}` in order [D40, D71]. A client that sees a gap
//! subscribes again for a fresh snapshot; a new connection always starts with one.

use brigadier::index::{self, Index};
use brigadier_core::data_dir;
use brigadier_frames::{take_lock, wire};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, Permissions};
use std::io::{self, Read};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::{process, thread};

const PROTOCOL_VERSION: u32 = 2;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
// shortcut: polls every log's size each tick (about 10k stats a second at 10k sessions); move to
// kqueue if that shows up in a profile.
const TICK: Duration = Duration::from_millis(500);
/// The commands that reach a host. The rest of the CLI prints to stdout or never returns.
const ROUTED: [&str; 5] = ["start", "send", "stop", "recover", "delete"];

struct Sub {
    out: Sender<String>,
    /// The subscribe request still waiting for the first list.
    waiting: Option<Value>,
}

#[derive(Default)]
struct State {
    n: u64,
    ready: bool,
    rows: BTreeMap<String, Value>,
    subs: HashMap<u64, Sub>,
}

type Shared = Arc<Mutex<State>>;

fn main() -> io::Result<()> {
    let data = data_dir();
    fs::create_dir_all(&data)?;
    fs::set_permissions(&data, Permissions::from_mode(0o700))?;
    // The kernel frees this lock however a daemon dies, so whoever holds it owns the socket and the
    // index, and two daemons starting together can't replace each other's.
    let Some(_lock) = take_lock(&data.join("daemon.lock"))? else {
        return Ok(());
    };
    let mut index = Index::open(&data, false)?;
    let listener = wire::bind(&data.join("daemon.sock"))?;
    let state = Shared::default();
    {
        let (state, data) = (state.clone(), data.clone());
        thread::spawn(move || {
            for (conn, stream) in (0u64..).zip(listener.incoming().flatten()) {
                let (state, data) = (state.clone(), data.clone());
                // A client that drops mid-handshake or mid-frame only ends its own connection.
                thread::spawn(move || serve(stream, conn, &state, &data));
            }
        });
    }
    loop {
        match index.sync() {
            Ok((rows, gone)) => publish(&state, rows, gone),
            Err(e) => eprintln!("brigadierd: {e}"),
        }
        thread::sleep(TICK);
    }
}

/// Applies one pass's changes as update N+1 and sends it, in order, to every subscriber. Requests
/// that came before the first pass get their snapshot now.
fn publish(state: &Shared, rows: Vec<Value>, gone: Vec<String>) {
    let mut s = state.lock().unwrap();
    let delta = !rows.is_empty() || !gone.is_empty();
    for row in &rows {
        s.rows
            .insert(row["id"].as_str().unwrap_or("").into(), row.clone());
    }
    for id in &gone {
        s.rows.remove(id);
    }
    s.n += delta as u64;
    s.ready = true;
    let State {
        n, rows: all, subs, ..
    } = &mut *s;
    let update = json!({"n": *n, "rows": rows, "gone": gone}).to_string();
    subs.retain(|_, sub| match sub.waiting.take() {
        Some(re) => sub.out.send(snapshot(&re, *n, all)).is_ok(),
        None => !delta || sub.out.send(update.clone()).is_ok(),
    });
}

fn snapshot(re: &Value, n: u64, rows: &BTreeMap<String, Value>) -> String {
    json!({"re": re, "n": n, "rows": rows.values().collect::<Vec<_>>()}).to_string()
}

fn serve(mut stream: UnixStream, conn: u64, state: &Shared, data: &Path) -> io::Result<()> {
    if wire::peer_uid(&stream)? != unsafe { libc::geteuid() } {
        return Ok(());
    }
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    let mut version = [0; 4];
    stream.read_exact(&mut version)?;
    stream.set_read_timeout(None)?;
    let version = u32::from_be_bytes(version);
    if version != PROTOCOL_VERSION {
        let refused = json!({"status": "refused", "error": format!("protocol version mismatch: daemon speaks {PROTOCOL_VERSION}, client sent {version}")});
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
    let hello =
        json!({"status": "running", "pid": process::id(), "version": env!("CARGO_PKG_VERSION")});
    let _ = out.send(hello.to_string());
    while let Ok(text) = wire::read_frame(&mut stream) {
        let req: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let re = req["id"].clone();
        match req["op"].as_str().unwrap_or("") {
            "subscribe" => {
                let mut s = state.lock().unwrap();
                let ready = s.ready;
                if ready {
                    let _ = out.send(snapshot(&re, s.n, &s.rows));
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
                let (out, data) = (out.clone(), PathBuf::from(data));
                // A start waits for its host to answer: never hold up this connection's reads.
                thread::spawn(move || {
                    let mut reply = match args.first() {
                        Some(cmd) if ROUTED.contains(&cmd.as_str()) => brigadier::run(&data, &args)
                            .unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()})),
                        _ => json!({"ok": false, "error": format!("not routed: {args:?}")}),
                    };
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
    state.lock().unwrap().subs.remove(&conn);
    Ok(())
}
