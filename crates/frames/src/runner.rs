//! Holds one session's agent child: spawns it on pipes or a PTY, appends every byte it writes to the
//! log, logs each input before writing it, and stops its whole process group. It knows nothing
//! about providers: whoever calls it decides the command line and the bytes.

use crate::log::{self, Reader, Writer};

mod input;
mod spawn;
mod stop;
mod term;
use crate::{procs, wire};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

/// The gate's pipe in the child, and the shell that waits on it and then becomes the agent ($0).
const GATE_FD: i32 = 3;
const GATE: &str = r#"IFS= read -r go <&3 || exit 1; exec 3<&-; exec "$0" "$@""#;

pub type Groups = Vec<(i32, u64)>;

struct Child {
    pid: i32,
    input: Option<File>,
    /// Its SPAWNED frame's seq: keys, resizes and inputs name the child they were meant for.
    spawn: u64,
    pty: bool,
    /// It exited, and its output is still being drained into the log.
    exited: bool,
}

/// What this host can do beyond the first frozen ops, so a client asks before it relies on any.
pub const CAPS: [&str; 2] = ["switch", "control"];
/// How long a final drain may take.
const DRAIN: Duration = Duration::from_secs(10);

pub struct Runner {
    pub dir: PathBuf,
    log: Mutex<Writer>,
    cids: Mutex<HashMap<String, bool>>,
    child: Mutex<Option<Child>>,
    groups: Mutex<Groups>,
    op: Mutex<()>,
    sizing: Mutex<()>,
    /// Counts stops, so a spawn that was under way during one can tell and honour it.
    stops: AtomicU64,
    /// Output pumps still copying, which may hold bytes not yet in the log.
    pumping: AtomicUsize,
    disk_full: AtomicBool,
    watch: Box<dyn Fn(&Groups) + Send + Sync>,
}

fn fail(error: impl std::fmt::Display) -> Value {
    json!({"ok": false, "error": error.to_string()})
}

fn is_full(e: &io::Error) -> bool {
    e.raw_os_error() == Some(libc::ENOSPC) || e.raw_os_error() == Some(libc::EDQUOT)
}

impl Runner {
    /// Opens the session at `dir`. The caller must already hold its lock. `watch` hears every
    /// change to the set of live process groups.
    pub fn open(dir: &Path, watch: Box<dyn Fn(&Groups) + Send + Sync>) -> io::Result<Arc<Runner>> {
        let path = dir.join("log");
        let writer = Writer::open(&path)?;
        let (mut cids, mut groups) = (HashMap::new(), vec![]);
        let mut reader = Reader::open(&path, 0, 0)?;
        let want = |k| matches!(k, log::INTENT | log::DELIVERED | log::SPAWNED);
        while let Some(frame) = reader.next_with(want)? {
            let v: Value = serde_json::from_slice(&frame.data).unwrap_or(Value::Null);
            match frame.kind {
                log::INTENT => drop(v["cid"].as_str().map(|c| cids.insert(c.to_string(), false))),
                log::DELIVERED => drop(v["cid"].as_str().map(|c| cids.insert(c.to_string(), true))),
                log::SPAWNED => {
                    groups.push((
                        v["pgid"].as_i64().unwrap_or(0) as i32,
                        v["start_us"].as_u64().unwrap_or(0),
                    ));
                }
                _ => {}
            }
        }
        let all = procs::all();
        groups.retain(|&(pgid, start)| pgid > 0 && !procs::group(&all, pgid, start).is_empty());
        let runner = Arc::new(Runner {
            dir: dir.to_path_buf(),
            log: Mutex::new(writer),
            cids: Mutex::new(cids),
            child: Mutex::new(None),
            groups: Mutex::new(groups),
            op: Mutex::new(()),
            sizing: Mutex::new(()),
            stops: AtomicU64::new(0),
            pumping: AtomicUsize::new(0),
            disk_full: AtomicBool::new(false),
            watch,
        });
        (runner.watch)(&runner.groups.lock().unwrap());
        // Inputs logged before this line were never delivered by this owner: the fold reads them so.
        let _ = runner.note(
            &json!({"event": "owner_started", "pid": std::process::id(), "build": wire::build()}),
        );
        Ok(runner)
    }

    pub fn append(&self, kind: u8, data: &[u8], sync: bool) -> io::Result<u64> {
        let result = self.log.lock().unwrap().append(kind, data, sync);
        if let Err(e) = &result {
            self.disk_full.store(is_full(e), Ordering::Relaxed);
        } else {
            self.disk_full.store(false, Ordering::Relaxed);
        }
        result
    }

    pub fn note(&self, data: &Value) -> io::Result<u64> {
        self.append(log::NOTE, data.to_string().as_bytes(), true)
    }

    pub fn busy(&self) -> bool {
        self.child.lock().unwrap().is_some()
    }

    pub fn groups(&self) -> Groups {
        self.groups.lock().unwrap().clone()
    }

    /// Some when nothing of this session runs. While the guard lives, every spawn and input waits,
    /// so the caller can exit or exec without leaving work unsupervised.
    pub fn retire(&self) -> Option<MutexGuard<'_, ()>> {
        let op = self.op.lock().unwrap();
        if self.busy() || self.pumping.load(Ordering::SeqCst) > 0 {
            return None;
        }
        let all = procs::all();
        let mut groups = self.groups.lock().unwrap();
        groups.retain(|&(g, s)| !procs::group(&all, g, s).is_empty());
        groups.is_empty().then_some(op)
    }

    pub fn handle(self: &Arc<Self>, req: &Value) -> Value {
        match req["op"].as_str().unwrap_or("") {
            "ping" => self.ping(),
            "spawn" => self.spawn(req),
            "input" => self.input(req),
            "keys" => self.keys(req),
            "resize" => self.resize(req),
            "stop" => self.stop(
                req["by"].as_str().unwrap_or("user"),
                req["grace_ms"].as_u64().unwrap_or(2000),
            ),
            "note" => self
                .note(&req["data"])
                .map_or_else(fail, |seq| json!({"ok": true, "seq": seq})),
            other => fail(format!("unknown op {other:?}")),
        }
    }

    fn ping(&self) -> Value {
        let (len, frames) = {
            let log = self.log.lock().unwrap();
            (log.len, log.frames)
        };
        let slot = self.child.lock().unwrap();
        let child = slot.as_ref().map(|c| c.pid);
        let spawn = slot.as_ref().map(|c| c.spawn);
        json!({"ok": true, "pid": std::process::id(), "build": wire::build(), "child": child, "spawn": spawn,
               "caps": CAPS, "frames": frames, "len": len, "disk_full": self.disk_full.load(Ordering::Relaxed)})
    }
}

/// Drill hook: dies at `point` when the command id starts with the prefix BRIGADIER_CRASH_AT names.
fn crash_at(point: &str, cid: &str) {
    let at = std::env::var("BRIGADIER_CRASH_AT").unwrap_or_default();
    if at.strip_prefix(point).is_some_and(|p| cid.starts_with(p)) {
        std::process::abort();
    }
}
