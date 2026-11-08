//! Starting the agent child behind its gate, logging its group, and pumping its output into the log.

use super::term::{end_mirror, size, start_mirror};
use super::{Child, DRAIN, GATE, GATE_FD, Runner, crash_at, fail};
use crate::spawn::{spawn_pipes, spawn_pty};
use crate::{log, procs, wire};
use serde_json::{Value, json};
use std::borrow::Cow;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

impl Runner {
    pub(super) fn spawn(self: &Arc<Self>, req: &Value) -> Value {
        let _op = self.op.lock().unwrap();
        // A handoff [D47] or a switch [D51]: only if nothing reached the log since the caller judged
        // it idle. The idle child goes first (a switch's terminal too), its exit and output logged.
        if let Some(len) = req["if_len"].as_u64()
            && self.log.lock().unwrap().len != len
        {
            return fail("changed");
        }
        let replace = (self.child.lock().unwrap())
            .as_ref()
            .filter(|c| {
                req["replace"] == true && (!c.pty || req["switch"].is_object()) && !c.exited
            })
            .map(|c| c.pid);
        let stops = self.stops.load(Ordering::SeqCst) + replace.is_some() as u64;
        if replace.is_some() {
            self.stop("handoff", 2000);
        }
        if !self.wait_free(replace.is_some()) {
            return fail("busy");
        }
        let mut req = Cow::Borrowed(req);
        if let Some(pid) = replace
            && let Some(len) = req["if_len"].as_u64()
        {
            match self.handoff_len(len, pid, stops) {
                Ok(len) => req.to_mut()["if_len"] = len.into(),
                Err(e) => return fail(e),
            }
        }
        let req = req.as_ref();
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
}
