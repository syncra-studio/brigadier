//! Holds one session's agent child: spawns it on pipes or a PTY, appends every byte it writes to the
//! log, logs each input before writing it, and stops its whole process group. It knows nothing
//! about providers: whoever calls it decides the command line and the bytes.

use crate::log::{self, Reader, Writer};
use crate::spawn::{spawn_pipes, spawn_pty};
use term::{end_mirror, size, start_mirror};

mod stop;
mod term;
use crate::{procs, wire};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::thread;
use std::time::{Duration, Instant};

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
    /// It exited, and its output (and its mirror's) is still being drained into the log.
    exited: bool,
}

/// What this host can do beyond the first frozen ops, so a client asks before it relies on any.
pub const CAPS: [&str; 1] = ["terminal"];
/// How long a final drain may take: a child's pipes, then its mirror's last read.
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
                    for g in [&v, &v["mirror"]] {
                        groups.push((
                            g["pgid"].as_i64().unwrap_or(0) as i32,
                            g["start_us"].as_u64().unwrap_or(0),
                        ));
                    }
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
        let (spawn, pty) = slot
            .as_ref()
            .map_or((None, false), |c| (Some(c.spawn), c.pty));
        json!({"ok": true, "pid": std::process::id(), "build": wire::build(), "child": child, "spawn": spawn, "pty": pty,
               "caps": CAPS, "frames": frames, "len": len, "disk_full": self.disk_full.load(Ordering::Relaxed)})
    }

    /// Logs the input durably before anything reaches the agent. Some(reply) means stop here: a
    /// repeat of a known command id, or a refusal.
    fn intent(&self, req: &Value) -> Option<Value> {
        let cid = req["cid"].as_str()?;
        let origin = req["origin"].as_str().unwrap_or("");
        if origin != "user" && origin != "system" {
            return Some(fail("origin must be user or system"));
        }
        let mut cids = self.cids.lock().unwrap();
        if let Some(&delivered) = cids.get(cid) {
            return Some(
                json!({"ok": true, "cid": cid, "dup": true, "result": if delivered { "delivered" } else { "logged" }}),
            );
        }
        let data = json!({"cid": cid, "origin": origin, "text": req["text"], "backend": req["backend"], "retry_of": req["retry_of"]});
        if let Err(e) = self.append(log::INTENT, data.to_string().as_bytes(), true) {
            return Some(
                json!({"ok": false, "cid": cid, "result": "not_logged", "error": e.to_string(), "disk_full": is_full(&e)}),
            );
        }
        cids.insert(cid.to_string(), false);
        // Drill hook: die between logging and writing to the agent.
        crash_at("after_intent:", cid);
        None
    }

    fn delivered(&self, cid: Option<&str>) {
        if let Some(cid) = cid
            && self
                .append(
                    log::DELIVERED,
                    json!({"cid": cid}).to_string().as_bytes(),
                    false,
                )
                .is_ok()
        {
            self.cids.lock().unwrap().insert(cid.to_string(), true);
        }
    }

    fn spawn(self: &Arc<Self>, req: &Value) -> Value {
        let _op = self.op.lock().unwrap();
        // A handoff [D47]: only if nothing reached the log since the caller judged the session idle.
        // Then the idle piped child goes first, its exit and output fully logged, before the new one.
        if let Some(len) = req["if_len"].as_u64()
            && self.log.lock().unwrap().len != len
        {
            return fail("changed");
        }
        let replace = req["replace"] == true
            && (self.child.lock().unwrap())
                .as_ref()
                .is_some_and(|c| !c.pty && !c.exited);
        let stops = self.stops.load(Ordering::SeqCst) + replace as u64; // a Stop meanwhile counts
        if replace {
            self.stop("handoff", 2000);
        }
        if !self.wait_free(replace) {
            return fail("busy");
        }
        if let Some(reply) = self.intent(req) {
            return reply;
        }
        let cid = req["cid"].as_str();
        let pty = req["pty"].as_bool().unwrap_or(false);
        let argv: Vec<&str> = req["argv"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let Some((program, args)) = argv.split_first() else {
            return fail("empty argv");
        };
        // The child waits at a gate until its group is logged and the watchdog knows it, so no work
        // ever runs untracked: if this host dies first, the gate reads EOF and nothing runs [D60].
        let (gate, mut go) = match io::pipe() {
            Ok(p) => p,
            Err(e) => return fail(format!("spawn failed: {e}")),
        };
        let gate_fd = gate.as_raw_fd();
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", GATE, *program])
            .args(args)
            .env_clear()
            .current_dir(req["cwd"].as_str().unwrap_or("/"));
        unsafe {
            command.pre_exec(move || {
                // dup2 is a no-op for a pipe already at 3, so close-on-exec is cleared either way.
                if libc::dup2(gate_fd, GATE_FD) < 0 || libc::fcntl(GATE_FD, libc::F_SETFD, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        for (k, v) in req["env"].as_object().into_iter().flatten() {
            command.env(k, v.as_str().unwrap_or(""));
        }
        let cwd = req["cwd"].as_str().unwrap_or("/");
        let spawned = procs::runnable(program, req["env"]["PATH"].as_str(), cwd).and_then(|()| {
            if pty {
                spawn_pty(
                    &mut command,
                    size(&req["cols"], 120),
                    size(&req["rows"], 40),
                )
            } else {
                spawn_pipes(&mut command, req["keep_stdin"].as_bool().unwrap_or(false))
            }
        });
        let (mut child, input, outputs) = match spawned {
            Ok(s) => s,
            Err(e) => {
                let _ = self
                    .note(&json!({"event": "spawn_failed", "cid": cid, "error": e.to_string()}));
                return json!({"ok": false, "cid": cid, "result": "logged", "error": format!("spawn failed: {e}")});
            }
        };
        // Drill hook: die between starting the child and logging its group.
        crash_at("after_fork:", cid.unwrap_or(""));
        let pid = child.id() as i32;
        let start_us = procs::info(pid).map_or(0, |p| p.start_us);
        // The mirror copies the CLI's own record of a terminal's work into this log, so the chat
        // shows it [D47]. It ends by itself when its stdin closes, so it never outlives this host.
        let mirror = match req["mirror"]["argv"]
            .is_array()
            .then(|| start_mirror(&req["mirror"], cwd))
        {
            Some(Err(e)) => {
                unsafe { libc::killpg(pid, libc::SIGKILL) };
                let _ = child.wait();
                return json!({"ok": false, "cid": cid, "result": "logged", "error": format!("mirror failed: {e}")});
            }
            Some(Ok(m)) => Some(m),
            None => None,
        };
        let mirror_group = mirror.as_ref().map(|m| {
            (
                m.0.id() as i32,
                procs::info(m.0.id() as i32).map_or(0, |p| p.start_us),
            )
        });
        let mut record = json!({"pid": pid, "pgid": pid, "start_us": start_us, "argv": argv, "backend": req["backend"], "cli_version": req["cli_version"],
                            "mode": if pty { "pty" } else { "pipe" }, "cid": cid, "owner_build": wire::build()});
        if pty {
            record["cols"] = size(&req["cols"], 120).into();
            record["rows"] = size(&req["rows"], 40).into();
        }
        if let Some((g, s)) = mirror_group {
            record["mirror"] = json!({"pgid": g, "start_us": s});
        }
        let spawn = match self.append(log::SPAWNED, record.to_string().as_bytes(), true) {
            Ok(seq) => seq,
            Err(e) => {
                unsafe { libc::killpg(pid, libc::SIGKILL) };
                let _ = child.wait();
                end_mirror(mirror);
                return json!({"ok": false, "cid": cid, "result": "logged", "error": e.to_string()});
            }
        };
        (self.groups.lock().unwrap()).extend(mirror_group.into_iter().chain([(pid, start_us)]));
        (self.watch)(&self.groups.lock().unwrap());
        // A stop that ran while this spawn was under way couldn't see this group: honour it now.
        if self.stops.load(Ordering::SeqCst) != stops {
            for (g, s) in mirror_group.into_iter().chain([(pid, start_us)]) {
                procs::signal_group(g, s, libc::SIGKILL);
            }
            let status = child.wait().ok();
            end_mirror(mirror);
            let exited = json!({"pid": pid, "code": status.and_then(|s| s.code()), "signal": status.and_then(|s| s.signal())});
            let _ = self.append(log::EXITED, exited.to_string().as_bytes(), false);
            return json!({"ok": false, "cid": cid, "result": "logged", "error": "stopped while starting"});
        }
        // Open the gate. A child that already died is seen by the wait below.
        let _ = go.write_all(b"\n");
        let (done, pumped) = mpsc::channel();
        let pumps = outputs.len();
        let (mut mirror_child, mirror_in, mirror_out) = match mirror {
            Some((c, i, o)) => (Some(c), Some(i), Some(o)),
            None => (None, None, None),
        };
        let (mirror_done, mirror_pumped) = mpsc::channel();
        self.pumping
            .fetch_add(pumps + mirror_out.is_some() as usize, Ordering::SeqCst);
        let streams = outputs.into_iter().map(|o| (o, done.clone()));
        for ((kind, stream), done) in
            streams.chain(mirror_out.map(|o| ((log::OUT, o), mirror_done)))
        {
            let me = self.clone();
            thread::spawn(move || {
                me.pump(kind, stream);
                me.pumping.fetch_sub(1, Ordering::SeqCst);
                let _ = done.send(());
            });
        }
        let mut input = input;
        let wrote = match (input.as_mut(), req["input"].as_str()) {
            (Some(f), Some(bytes)) => f.write_all(bytes.as_bytes()).and_then(|_| f.flush()),
            _ => Ok(()),
        };
        *self.child.lock().unwrap() = Some(Child {
            pid,
            input,
            spawn,
            pty,
            exited: false,
        });
        let me = self.clone();
        thread::spawn(move || {
            let status = child.wait().ok();
            if let Some(c) = me.child.lock().unwrap().as_mut().filter(|c| c.pid == pid) {
                c.exited = true;
            }
            // The mirror makes its last read once its stdin closes, then ends.
            drop(mirror_in);
            // Log the exit after the output it produced: wait for the pipes to end, but not for long,
            // since a background job may hold them open.
            let deadline = Instant::now() + Duration::from_secs(2);
            for _ in 0..pumps {
                if pumped
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .is_err()
                {
                    break;
                }
            }
            // The mirror's last read can take a moment (a CLI call); one that hangs is cut off.
            if let Some((g, s)) = mirror_group
                && mirror_pumped.recv_timeout(DRAIN).is_err()
            {
                procs::signal_group(g, s, libc::SIGKILL);
            }
            let code = status.and_then(|s| s.code());
            let signal = status.and_then(|s| s.signal());
            let exited = json!({"pid": pid, "code": code, "signal": signal}).to_string();
            while me.append(log::EXITED, exited.as_bytes(), false).is_err() {
                thread::sleep(Duration::from_millis(500));
            }
            let mut slot = me.child.lock().unwrap();
            if slot.as_ref().is_some_and(|c| c.pid == pid) {
                *slot = None;
            }
            drop(slot);
            if let Some(m) = mirror_child.as_mut() {
                let _ = m.wait();
            }
        });
        // A first message the child never took stays logged, not delivered, like a later one.
        if let Err(e) = wrote {
            return json!({"ok": true, "cid": cid, "result": "logged", "error": e.to_string(), "pid": pid});
        }
        self.delivered(cid);
        json!({"ok": true, "cid": cid, "result": if cid.is_some() { "delivered" } else { "spawned" }, "pid": pid, "spawn": spawn})
    }

    /// Copies a child stream into the log. When the disk is full it holds the bytes and retries,
    /// so the child blocks on a full pipe rather than its output being lost.
    fn pump(&self, kind: u8, mut stream: File) {
        let mut buf = vec![0u8; 64 << 10];
        loop {
            let n = match stream.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            while self.append(kind, &buf[..n], false).is_err() {
                thread::sleep(Duration::from_millis(500));
            }
        }
    }

    fn input(&self, req: &Value) -> Value {
        let _op = self.op.lock().unwrap();
        {
            let slot = self.child.lock().unwrap();
            let Some(c) = slot.as_ref().filter(|c| c.input.is_some() && !c.exited) else {
                return fail("no_child");
            };
            // Bytes made for another child (a handoff happened since) are refused before logging.
            if req["spawn"].as_u64().is_some_and(|s| s != c.spawn) {
                return fail("changed");
            }
        }
        if let Some(reply) = self.intent(req) {
            return reply;
        }
        let cid = req["cid"].as_str();
        let bytes = req["bytes"].as_str().unwrap_or("");
        // Written outside the child lock, so a child that stopped reading can't freeze ping or exit.
        let input = self
            .child
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|c| c.input.as_ref().and_then(|f| f.try_clone().ok()));
        let written = match input {
            Some(mut f) => f.write_all(bytes.as_bytes()).and_then(|_| f.flush()),
            None => Err(io::Error::other("child exited")),
        };
        match written {
            Ok(()) => {
                self.delivered(cid);
                json!({"ok": true, "cid": cid, "result": "delivered"})
            }
            Err(e) => json!({"ok": true, "cid": cid, "result": "logged", "error": e.to_string()}),
        }
    }
}

/// Drill hook: dies at `point` when the command id starts with the prefix BRIGADIER_CRASH_AT names.
fn crash_at(point: &str, cid: &str) {
    let at = std::env::var("BRIGADIER_CRASH_AT").unwrap_or_default();
    if at.strip_prefix(point).is_some_and(|p| cid.starts_with(p)) {
        std::process::abort();
    }
}
