//! Holds one session's agent child: spawns it on pipes or a PTY, appends every byte it writes to the
//! log, logs each input before writing it, and stops its whole process group. It knows nothing
//! about providers: whoever calls it decides the command line and the bytes.

use crate::log::{self, Reader, Writer};
use crate::{procs, wire};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::thread;
use std::time::{Duration, Instant};

// TIOCSCTTY isn't exported by libc for Apple targets; _IO('t', 97).
const TIOCSCTTY: libc::c_ulong = 0x2000_7461;
/// The gate's pipe in the child, and the shell that waits on it and then becomes the agent ($0).
const GATE_FD: i32 = 3;
const GATE: &str = r#"IFS= read -r go <&3 || exit 1; exec 3<&-; exec "$0" "$@""#;

pub type Groups = Vec<(i32, u64)>;

struct Child {
    pid: i32,
    input: Option<File>,
}

pub struct Runner {
    pub dir: PathBuf,
    log: Mutex<Writer>,
    cids: Mutex<HashMap<String, bool>>,
    child: Mutex<Option<Child>>,
    groups: Mutex<Groups>,
    /// Held by spawn and input, and by `retire` while the host leaves.
    op: Mutex<()>,
    /// Counts stops, so a spawn that was under way during one can tell and honour it.
    stops: AtomicU64,
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
                log::SPAWNED => groups.push((
                    v["pgid"].as_i64().unwrap_or(0) as i32,
                    v["start_us"].as_u64().unwrap_or(0),
                )),
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
            stops: AtomicU64::new(0),
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
        if self.busy() {
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
        let child = self.child.lock().unwrap().as_ref().map(|c| c.pid);
        json!({"ok": true, "pid": std::process::id(), "build": wire::build(), "child": child, "frames": frames, "len": len,
               "disk_full": self.disk_full.load(Ordering::Relaxed)})
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
        if let Ok(at) = std::env::var("BRIGADIER_CRASH_AT")
            && at
                .strip_prefix("after_intent:")
                .is_some_and(|p| cid.starts_with(p))
        {
            std::process::abort();
        }
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
        let stops = self.stops.load(Ordering::SeqCst);
        if self.busy() {
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
        let spawned = if pty {
            spawn_pty(&mut command)
        } else {
            spawn_pipes(&mut command, req["keep_stdin"].as_bool().unwrap_or(false))
        };
        let (mut child, input, outputs) = match spawned {
            Ok(s) => s,
            Err(e) => {
                let _ = self
                    .note(&json!({"event": "spawn_failed", "cid": cid, "error": e.to_string()}));
                return json!({"ok": false, "cid": cid, "result": "logged", "error": format!("spawn failed: {e}")});
            }
        };
        // Drill hook: die between starting the child and logging its group.
        if std::env::var("BRIGADIER_CRASH_AT").is_ok_and(|at| {
            cid.is_some_and(|c| {
                at.strip_prefix("after_fork:")
                    .is_some_and(|p| c.starts_with(p))
            })
        }) {
            std::process::abort();
        }
        let pid = child.id() as i32;
        let start_us = procs::info(pid).map_or(0, |p| p.start_us);
        let record = json!({"pid": pid, "pgid": pid, "start_us": start_us, "argv": argv, "backend": req["backend"], "cli_version": req["cli_version"],
                            "mode": if pty { "pty" } else { "pipe" }, "cid": cid, "owner_build": wire::build()});
        if let Err(e) = self.append(log::SPAWNED, record.to_string().as_bytes(), true) {
            unsafe { libc::killpg(pid, libc::SIGKILL) };
            let _ = child.wait();
            return json!({"ok": false, "cid": cid, "result": "logged", "error": e.to_string()});
        }
        self.groups.lock().unwrap().push((pid, start_us));
        (self.watch)(&self.groups.lock().unwrap());
        // A stop that ran while this spawn was under way couldn't see this group: honour it now.
        if self.stops.load(Ordering::SeqCst) != stops {
            procs::signal_group(pid, start_us, libc::SIGKILL);
            let status = child.wait().ok();
            let exited = json!({"pid": pid, "code": status.and_then(|s| s.code()), "signal": status.and_then(|s| s.signal())});
            let _ = self.append(log::EXITED, exited.to_string().as_bytes(), false);
            return json!({"ok": false, "cid": cid, "result": "logged", "error": "stopped while starting"});
        }
        // Open the gate. A child that already died is seen by the wait below.
        let _ = go.write_all(b"\n");
        let (done, pumped) = mpsc::channel();
        let pumps = outputs.len();
        for (kind, stream) in outputs {
            let me = self.clone();
            let done = done.clone();
            thread::spawn(move || {
                me.pump(kind, stream);
                let _ = done.send(());
            });
        }
        let mut input = input;
        let wrote = match (input.as_mut(), req["input"].as_str()) {
            (Some(f), Some(bytes)) => f.write_all(bytes.as_bytes()).and_then(|_| f.flush()),
            _ => Ok(()),
        };
        *self.child.lock().unwrap() = Some(Child { pid, input });
        let me = self.clone();
        thread::spawn(move || {
            let status = child.wait().ok();
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
        });
        // A first message the child never took stays logged, not delivered, like a later one.
        if let Err(e) = wrote {
            return json!({"ok": true, "cid": cid, "result": "logged", "error": e.to_string(), "pid": pid});
        }
        self.delivered(cid);
        json!({"ok": true, "cid": cid, "result": if cid.is_some() { "delivered" } else { "spawned" }, "pid": pid})
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
        if !self
            .child
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|c| c.input.is_some())
        {
            return fail("no_child");
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

    /// Stops every process group this session started: TERM (and CONT, so a stopped one can act on
    /// it), then KILL after `grace_ms`. Never waits on the input lock, so a stuck write can't block it.
    pub fn stop(&self, by: &str, grace_ms: u64) -> Value {
        let started = Instant::now();
        self.stops.fetch_add(1, Ordering::SeqCst);
        let _ = self.append(log::STOPPED, json!({"by": by}).to_string().as_bytes(), true);
        let groups = self.groups();
        let live = |groups: &Groups| {
            let all = procs::all();
            groups
                .iter()
                .map(|&(g, s)| procs::group(&all, g, s).len())
                .sum::<usize>()
        };
        for &(g, s) in &groups {
            procs::signal_group(g, s, libc::SIGTERM);
            procs::signal_group(g, s, libc::SIGCONT);
        }
        let mut left = live(&groups);
        let deadline = Instant::now() + Duration::from_millis(grace_ms);
        while left > 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
            left = live(&groups);
        }
        if left > 0 {
            for &(g, s) in &groups {
                procs::signal_group(g, s, libc::SIGKILL);
            }
            let deadline = Instant::now() + Duration::from_secs(2);
            while left > 0 && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(25));
                left = live(&groups);
            }
        }
        let all = procs::all();
        self.groups
            .lock()
            .unwrap()
            .retain(|&(g, s)| !procs::group(&all, g, s).is_empty());
        (self.watch)(&self.groups.lock().unwrap());
        json!({"ok": left == 0, "left": left, "ms": started.elapsed().as_millis() as u64})
    }
}

type Spawned = (std::process::Child, Option<File>, Vec<(u8, File)>);

fn spawn_pipes(command: &mut Command, keep_stdin: bool) -> io::Result<Spawned> {
    command
        .stdin(if keep_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.process_group(0);
    let mut child = command.spawn()?;
    let file = |fd: OwnedFd| File::from(fd);
    let input = child.stdin.take().map(|s| file(s.into()));
    let out = file(child.stdout.take().expect("piped").into());
    let err = file(child.stderr.take().expect("piped").into());
    Ok((child, input, vec![(log::OUT, out), (log::ERR, err)]))
}

fn spawn_pty(command: &mut Command) -> io::Result<Spawned> {
    let (mut master, mut slave) = (0, 0);
    let mut size = libc::winsize {
        ws_row: 40,
        ws_col: 120,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    if unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    // openpty's fds aren't close-on-exec: without this, every later child inherits this terminal
    // and keeps it open after its owner dies.
    for fd in [master, slave] {
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
    let master = unsafe { File::from_raw_fd(master) };
    let slave = unsafe { File::from_raw_fd(slave) };
    command
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave));
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 || libc::ioctl(0, TIOCSCTTY, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn()?;
    // The parent's slave copies were moved into `command` and close when it drops.
    Ok((child, Some(master.try_clone()?), vec![(log::PTY, master)]))
}
