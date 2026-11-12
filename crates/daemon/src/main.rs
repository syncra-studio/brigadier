//! `brigadierd`: the app's one way to every host [D40, D60]. It keeps the session list from the
//! logs (`index.db`, off the write path [D67]), sweeps what dead hosts left running, and routes the
//! app's commands to the hosts. Killing it leaves every host working: they never depend on it.
//!
//! Its protocol is its own (the hosts keep theirs): the 4-byte version, a hello, then JSON frames.
//! `{"id", "op": "subscribe"}` answers `{"re", "n", "rows", "projects"}`, the lists at N, and then
//! pushes `{"n": N+1, "rows", "gone", "projects", "projects_gone"}`, `{"n": N+2, …}` in order, each
//! naming what changed by id [D40, D71]. A client that sees a gap subscribes again for a fresh
//! snapshot; a new connection always starts with one.
//!
//! `{"id", "op": "thread", "session"}` answers `{"re", "ok", "n", "session"}`, the session's thread
//! (`item.ts`) at N, and then pushes `{"thread", "n": N+1, "items", "turns", "work"}`, each replacing
//! what it names by id [D40, D64, D65]. One thread per connection: a new request ends the last.
//! `{"id", "op": "peek", "session"}` answers the same snapshot and follows nothing, so a session the
//! pointer is on opens at once while the open thread stays followed [D477].
//! The snapshot holds only the newest whole turns, about 2k rows, and `before`: the `n` of its
//! first row, or null when nothing is older; with `"from"` and `"to"` (`n`s) it reaches back to
//! row `from`'s turn and ends before row `to`, the rows a view opened again held, `after` naming
//! the first not sent. `{"id", "op": "thread_older", "session", "before"}`
//! answers `{"re", "ok", "items", "turns", "work", "before", "after"}`, the page before that
//! [D97, D98]; with `"after"` instead, the page from that row on down. `{"id", "op":
//! "thread_around", "session", "n"}` answers the same shape for the whole turns around row `n`,
//! an island find goes to, `before` and `after` naming the rows not sent on each side [D503].
//! `{"id", "op": "thread_find", "session", "before", "query", "limit"}` answers `{"re", "ok",
//! "matches": [{"n", "count"}], "more"}`: find in the conversation, for the rows not loaded [D470].
//! Threads are folded from each session's saved thread (`store`), saved as turns end [D503].
//!
//! `{"id", "op": "git", "session" | "project"}` follows that checkout's status the same way: a
//! snapshot, then what changed by path (see `git`) [D71].
//!
//! `{"id", "op": "terminal", "session"}` streams a sign-in's terminal (see `term`); `keys` and
//! `resize` go to its host, named by the terminal's spawn id [D45].
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
mod caller;
mod git;
mod install;
mod ops;
mod prs;
mod store;
mod switch;
mod term;
mod watch;

const PROTOCOL_VERSION: u32 = wire::DAEMON_PROTOCOL;
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
    projects: BTreeMap<String, Value>,
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
    // Before a delete or archive cut short takes the folder a Replace all cut short left files in.
    brigadier_core::git::recover::sweep(&data);
    brigadier_core::worktrees::sweep(&data);
    brigadier::rewind::sweep(&data);
    git::auto_fetch(data.clone());
    let mut index = Index::open(&data, false)?;
    let listener = wire::bind(&data.join("daemon.sock"))?;
    let state = Shared::default();
    let store = Arc::new(store::Store::default());
    prs::watch(data.clone(), state.clone());
    {
        let (state, data, store) = (state.clone(), data.clone(), store.clone());
        thread::spawn(move || {
            for (conn, stream) in (0u64..).zip(listener.incoming().flatten()) {
                let (state, data, store) = (state.clone(), data.clone(), store.clone());
                // A client that drops mid-handshake or mid-frame only ends its own connection.
                thread::spawn(move || ops::serve(stream, conn, &state, &data, &store));
            }
        });
    }
    // Saves each session's thread as its turns end, and at start every one not saved yet, the
    // first time once [D503]: in the background, at the lowest priority, so it never holds up
    // a live turn or the app.
    let (ended, queue) = std::sync::mpsc::channel::<String>();
    {
        let (data, store) = (data.clone(), store.clone());
        thread::spawn(move || {
            unsafe {
                libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0)
            };
            for id in queue {
                store.catch_up(&data, &id);
            }
        });
    }
    let mut ends: HashMap<String, Value> = HashMap::new();
    // The limit each session was last looked at for, by its item count and the switching settings:
    // once per limit, and again when a setting or the accounts change [D51].
    let mut seen: HashMap<String, Value> = HashMap::new();
    let mut finished: HashMap<String, u64> = HashMap::new();
    loop {
        match index.sync() {
            Ok((rows, gone)) => {
                for row in &rows {
                    let id = row["id"].as_str().unwrap_or("");
                    if ends.insert(id.into(), row["finished"].clone()).as_ref()
                        != Some(&row["finished"])
                    {
                        let _ = ended.send(id.into());
                    }
                }
                for id in &gone {
                    ends.remove(id);
                }
                publish(&state, &data, rows, gone)
            }
            Err(e) => eprintln!("brigadierd: {e}"),
        }
        switch::auto_switch(&data, &index.rows, &mut seen);
        brigadier::rewind::ends(&data, &index.rows, &mut finished);
        brigadier::queue::drain(&data, &index.rows);
        brigadier::workers::pass(&data, &index.rows);
        brigadier::peers::pass(&data, &index.rows);
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

/// Applies one pass's changes, and the projects' (read under the lock, so two readers never send
/// them out of order), as update N+1 and sends it, in order, to every subscriber. Requests that
/// came before the first pass get their snapshot now.
// shortcut: reads `projects.json` every pass, a small file (proposed); stat it first if many
// projects ever make that show in a profile.
fn publish(state: &Shared, data: &Path, rows: Vec<Value>, gone: Vec<String>) {
    let mut s = state.lock().unwrap();
    let (mut projects, mut projects_gone) = (vec![], vec![]);
    match brigadier_core::projects::list(data) {
        Ok(list) => {
            let list: BTreeMap<String, Value> =
                list.into_iter().map(|p| (p.id.clone(), json!(p))).collect();
            projects_gone = s
                .projects
                .keys()
                .filter(|id| !list.contains_key(*id))
                .cloned()
                .collect();
            projects = list
                .iter()
                .filter(|(id, p)| s.projects.get(*id) != Some(p))
                .map(|(_, p)| p.clone())
                .collect();
            s.projects = list;
        }
        // A damaged file keeps the last list it read.
        Err(e) => eprintln!("brigadierd: projects: {e}"),
    }
    // A turn's start or end reads its session's checkout again [D48]: `running` is whether the fold
    // has a turn open, and `finished` moves at each end, so a turn begun and ended within one pass
    // still counts.
    let turned: Vec<&str> = (rows.iter())
        .filter(|row| {
            let old = s.rows.get(row["id"].as_str().unwrap_or(""));
            old.is_none_or(|old| {
                old["running"] != row["running"] || old["finished"] != row["finished"]
            })
        })
        .filter_map(|row| row["id"].as_str())
        .collect();
    git::turned(data, &turned);
    prs::turned(&turned);
    let delta =
        !rows.is_empty() || !gone.is_empty() || !projects.is_empty() || !projects_gone.is_empty();
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
        n,
        rows: all,
        projects: all_projects,
        subs,
        ..
    } = &mut *s;
    let update = json!({"n": *n, "rows": rows, "gone": gone, "projects": projects,
        "projects_gone": projects_gone});
    let update = update.to_string();
    subs.retain(|_, sub| match sub.waiting.take() {
        Some(re) => sub.out.send(snapshot(&re, *n, all, all_projects)).is_ok(),
        None => !delta || sub.out.send(update.clone()).is_ok(),
    });
}

fn snapshot(
    re: &Value,
    n: u64,
    rows: &BTreeMap<String, Value>,
    projects: &BTreeMap<String, Value>,
) -> String {
    let (rows, projects) = (rows.values(), projects.values());
    json!({"re": re, "n": n, "rows": rows.collect::<Vec<_>>(), "projects": projects.collect::<Vec<_>>()})
        .to_string()
}
