//! `brigadierd`: the app's one way to every host [D40, D60]. It keeps the session list from the
//! logs (`index.db`, off the write path [D67]), sweeps what dead hosts left running, and routes the
//! app's commands to the hosts. Killing it leaves every host working: they never depend on it.
//!
//! Its protocol is its own (the hosts keep theirs): the 4-byte version, a hello, then JSON frames.
//! `{"id", "op": "subscribe"}` answers `{"re", "n", "rows"}`, the list at N, and then pushes
//! `{"n": N+1, "rows", "gone"}`, `{"n": N+2, …}` in order [D40, D71]. A client that sees a gap
//! subscribes again for a fresh snapshot; a new connection always starts with one.
//!
//! `{"id", "op": "thread", "session"}` answers `{"re", "ok", "n", "session"}`, the session's thread
//! (`item.ts`) at N, and then pushes `{"thread", "n": N+1, "items", "turns", "work"}`, each replacing
//! what it names by id [D40, D64, D65]. One thread per connection: a new request ends the last.
//!
//! The app starts one at every launch: it leaves at once if this build or a newer one runs, and
//! replaces an older one (`replace_older`).

use brigadier::index::{self, Index};
use brigadier_core::fold;
use brigadier_core::norm::Norm;
use brigadier_core::thread::Thread;
use brigadier_core::{check_id, data_dir, session_dir};
use brigadier_frames::log::{Reader, now_ms};
use brigadier_frames::procs;
use brigadier_frames::{lock_held, take_lock, wire};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, Permissions};
use std::io::{self, Read, Write};
use std::mem::size_of;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::{process, thread};

const PROTOCOL_VERSION: u32 = 2;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
// shortcut: polls every log's size each tick (about 10k stats a second at 10k sessions); move to
// kqueue if that shows up in a profile.
const TICK: Duration = Duration::from_millis(500);
/// The commands that reach a host. The rest of the CLI prints to stdout or never returns.
const ROUTED: [&str; 5] = ["start", "send", "stop", "recover", "delete"];
/// How often an open thread checks its log for new frames.
const FOLLOW: Duration = Duration::from_millis(100);

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
    let lock = data.join("daemon.lock");
    let _lock = match take_lock(&lock)? {
        Some(held) => held,
        None if replace_older(&data)? => match take_lock(&lock)? {
            Some(held) => held,
            None => return Ok(()),
        },
        None => return Ok(()),
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

/// An app update starts its daemon while the old one still runs. Stops the running one if its build
/// number is lower, and says whether it did. A daemon from before build numbers (no `build` in its
/// hello or refusal) counts as older. A refusal alone is never a reason, and a daemon that doesn't
/// answer or is the same build or newer stays, so two app copies never replace each other's.
fn replace_older(data: &Path) -> io::Result<bool> {
    // Nothing answering means a daemon still starting up: leave it be.
    let Ok(mut stream) = UnixStream::connect(data.join("daemon.sock")) else {
        return Ok(false);
    };
    if wire::peer_uid(&stream)? != unsafe { libc::geteuid() } {
        return Ok(false);
    }
    // The kernel names the listener, whatever version it is.
    let mut pid: libc::pid_t = 0;
    let mut len = size_of::<libc::pid_t>() as libc::socklen_t;
    let got = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&raw mut pid).cast(),
            &mut len,
        )
    };
    if got != 0 || pid <= 0 {
        return Ok(false);
    }
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    stream.write_all(&PROTOCOL_VERSION.to_be_bytes())?;
    let Some(first) = wire::read_frame(&mut stream)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    else {
        return Ok(false);
    };
    if first["build"]
        .as_u64()
        .is_some_and(|b| b >= wire::build() as u64)
    {
        return Ok(false);
    }
    drop(stream);
    let lock = data.join("daemon.lock");
    for sig in [libc::SIGTERM, libc::SIGKILL] {
        unsafe { libc::kill(pid, sig) };
        let deadline = Instant::now() + Duration::from_secs(2);
        while lock_held(&lock) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        if !lock_held(&lock) {
            break;
        }
    }
    Ok(true)
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
            "thread" => {
                let id = req["session"].as_str().unwrap_or("").to_string();
                let title = state
                    .lock()
                    .unwrap()
                    .rows
                    .get(&id)
                    .map_or(Value::Null, |r| r["title"].clone());
                let mine = watching.fetch_add(1, Ordering::SeqCst) + 1;
                let (out, data, watching) = (out.clone(), PathBuf::from(data), watching.clone());
                thread::spawn(move || watch(&data, &id, title, re, &out, mine, &watching));
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
    watching.fetch_add(1, Ordering::SeqCst);
    state.lock().unwrap().subs.remove(&conn);
    Ok(())
}

/// Folds a session's log into its thread, sends it, then follows the log and sends what changed,
/// numbered on from the snapshot and tagged with this watch's request, until `watching` moves past
/// `mine`. A host that died mid-turn writes no frame, so the live state ends such a turn [D60].
// shortcut: every open folds the whole log and sends the whole thread; add a thread checkpoint and
// paging once long sessions make opening slow.
fn watch(
    data: &Path,
    id: &str,
    title: Value,
    re: Value,
    out: &Sender<String>,
    mine: u64,
    watching: &AtomicU64,
) {
    let dir = session_dir(data, id);
    if check_id(id).is_err() || !dir.join("session.json").exists() {
        let _ = out.send(json!({"re": re, "ok": false, "error": "not_found"}).to_string());
        return;
    }
    let (mut thread, mut norm, mut items) = (Thread::default(), Norm::default(), vec![]);
    let mut reader: Option<Reader> = None;
    let log = dir.join("log");
    let inode = |path: &Path| fs::metadata(path).map(|m| m.ino()).ok();
    let mut drain = |thread: &mut Thread| -> io::Result<()> {
        // A session just created may have no log yet.
        if reader.is_none() && log.exists() {
            reader = Some(Reader::open(&log, 0, 0)?);
        }
        while let Some(frame) = reader.as_mut().map(Reader::frame).transpose()?.flatten() {
            norm.push(&frame, &mut items);
            for item in items.drain(..) {
                thread.push(&item);
            }
        }
        Ok(())
    };
    let interrupted = |thread: &mut Thread| {
        let owner = brigadier::owner::state(data, id);
        let live = fold::live(thread.status_fold(), owner, data, &procs::all());
        if thread.running() && fold::status(thread.status_fold(), &live)["state"] == "interrupted" {
            thread.interrupt(now_ms());
        }
    };
    if let Err(e) = drain(&mut thread) {
        let _ = out.send(json!({"re": re, "ok": false, "error": e.to_string()}).to_string());
        return;
    }
    interrupted(&mut thread);
    let title = title.as_str().unwrap_or("");
    let snapshot = json!({"re": re, "ok": true, "n": 0, "session": thread.session(id, title)});
    if out.send(snapshot.to_string()).is_err() {
        return;
    }
    let tag = |mut frame: Value| {
        frame["thread"] = id.into();
        frame["watch"] = re.clone();
        frame.to_string()
    };
    let (mut opened, mut n) = (inode(&log), 0u64);
    for tick in 1u64.. {
        thread::sleep(FOLLOW);
        if watching.load(Ordering::SeqCst) != mine {
            return;
        }
        // Deleted: say so. Replaced (deleted and made again): the client asks for a fresh thread.
        if !dir.join("session.json").exists() {
            let _ = out.send(tag(json!({"error": "not_found"})));
            return;
        }
        let now = inode(&log);
        if opened.is_some() && now != opened {
            let _ = out.send(tag(json!({"reset": true})));
            return;
        }
        opened = now;
        // A damaged frame stays damaged: say so once and stop following.
        if let Err(e) = drain(&mut thread) {
            let _ = out.send(tag(json!({"error": e.to_string()})));
            return;
        }
        if tick % 10 == 0 && thread.running() {
            interrupted(&mut thread);
        }
        if let Some((items, turns, work)) = thread.take() {
            n += 1;
            let update = json!({"n": n, "items": items, "turns": turns, "work": work});
            if out.send(tag(update)).is_err() {
                return;
            }
        }
    }
}
