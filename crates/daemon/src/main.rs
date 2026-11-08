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
//! The snapshot holds only the newest whole turns, about 2k rows, and `before`: the `n` of its
//! first row, or null when nothing is older. `{"id", "op": "thread_older", "session", "before"}`
//! answers `{"re", "ok", "items", "turns", "work", "before"}`, the page before that [D97, D98].
//!
//! `{"id", "op": "terminal", "session"}` streams the session's terminal (see `term`); `keys` and
//! `resize` go to its host, named by the terminal's spawn id [D47].
//!
//! The app starts one at every launch: it leaves at once if this build or a newer one runs, and
//! replaces an older one (`replace_older`). A packaged app starts it with `--install` (`install`).
//! While it runs it keeps the Mac awake as `brigadier awake` says: off, while a session works, or
//! always (`awake`) [D30, D36].

use brigadier::index::Index;
use brigadier_core::{awake_mode, data_dir};
use brigadier_frames::{lock_held, take_lock, wire};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, Permissions};
use std::io::{self, Write};
use std::mem::size_of;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

mod awake;
mod install;
mod ops;
mod switch;
mod term;
mod watch;

const PROTOCOL_VERSION: u32 = 2;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
// shortcut: polls every log's size each tick (about 10k stats a second at 10k sessions); move to
// kqueue if that shows up in a profile.
const TICK: Duration = Duration::from_millis(500);

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
    if std::env::args().nth(1).as_deref() == Some("--install") {
        return install::install_and_exec(&data);
    }
    // The kernel frees this lock however a daemon dies, so whoever holds it owns the socket and the
    // index, and two daemons starting together can't replace each other's.
    let lock = data.join("daemon.lock");
    let mut awake = awake::Awake::default();
    let _lock = match take_lock(&lock)? {
        Some(held) => held,
        None if replace_older(&data, &mut awake)? => match take_lock(&lock)? {
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
                thread::spawn(move || ops::serve(stream, conn, &state, &data));
            }
        });
    }
    // The limit each session was last looked at for, by its item count and the switching settings:
    // once per limit, and again when a setting or the accounts change [D51].
    let mut seen: HashMap<String, Value> = HashMap::new();
    loop {
        match index.sync() {
            Ok((rows, gone)) => publish(&state, rows, gone),
            Err(e) => eprintln!("brigadierd: {e}"),
        }
        switch::auto_switch(&data, &index.rows, &mut seen);
        // Off, while a session works, or always [D30, D36]. A failed pass keeps its folded rows.
        let on = match awake_mode(&data) {
            "off" => false,
            "always" => true,
            _ => index.rows.values().any(|r| r["works"] == true),
        };
        awake.set(on);
        thread::sleep(TICK);
    }
}

/// An app update starts its daemon while the old one still runs. Stops the running one if its build
/// number is lower, and says whether it did. A daemon from before build numbers (no `build` in its
/// hello or refusal) counts as older. A refusal alone is never a reason, and a daemon that doesn't
/// answer or is the same build or newer stays, so two app copies never replace each other's.
fn replace_older(data: &Path, awake: &mut awake::Awake) -> io::Result<bool> {
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
    // The old one may hold the Mac awake: hold first, until this one's first pass decides.
    if awake_mode(data) != "off" {
        awake.hold_confirmed();
    }
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
