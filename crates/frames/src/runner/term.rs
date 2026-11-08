//! The terminal side of the runner: waiting out a handoff, keys and resizes for the live PTY, and
//! the mirror that copies a terminal's work into the log [D47].

use super::{DRAIN, Runner, fail};
use crate::spawn::{resize, spawn_pipes};
use serde_json::{Value, json};
use std::fs::File;
use std::io::{self, Write};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

impl Runner {
    /// Waits for the child slot to empty: always when `any`, else only for a child that exited and
    /// is still being drained. False when it stays taken.
    pub(super) fn wait_free(&self, any: bool) -> bool {
        let deadline = Instant::now() + DRAIN + Duration::from_secs(3);
        loop {
            match self.child.lock().unwrap().as_ref() {
                None => return true,
                Some(c) if !any && !c.exited => return false,
                _ if Instant::now() > deadline => return false,
                _ => {}
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// The live terminal's master, if `req` names it by its spawn id: a stale one gets None.
    fn terminal(&self, req: &Value) -> Option<File> {
        let slot = self.child.lock().unwrap();
        let c = slot.as_ref().filter(|c| c.pty && !c.exited)?;
        (req["spawn"].as_u64() == Some(c.spawn))
            .then(|| c.input.as_ref()?.try_clone().ok())
            .flatten()
    }

    /// Keystrokes for the terminal. Not logged: they aren't messages, and may be anything typed.
    pub(super) fn keys(&self, req: &Value) -> Value {
        let Some(mut master) = self.terminal(req) else {
            return fail("changed");
        };
        let bytes = req["bytes"].as_str().unwrap_or("");
        match master.write_all(bytes.as_bytes()) {
            Ok(()) => json!({"ok": true}),
            Err(e) => fail(e),
        }
    }

    /// Resizes the terminal, logged first and in order, so a replay redraws the same screen.
    pub(super) fn resize(&self, req: &Value) -> Value {
        let Some(master) = self.terminal(req) else {
            return fail("changed");
        };
        let (cols, rows) = (size(&req["cols"], 120), size(&req["rows"], 40));
        let _sizing = self.sizing.lock().unwrap();
        let note = json!({"event": "resize", "spawn": req["spawn"], "cols": cols, "rows": rows});
        if let Err(e) = self.note(&note) {
            return fail(e);
        }
        resize(&master, cols, rows).map_or_else(fail, |()| json!({"ok": true}))
    }
}

/// A terminal dimension, kept to what a PTY can take.
pub(super) fn size(v: &Value, default: u16) -> u16 {
    v.as_u64().map_or(default, |n| n.clamp(1, 1000) as u16)
}

pub(super) type Mirror = (std::process::Child, File, File);

/// Kills and reaps a mirror whose terminal never got going.
pub(super) fn end_mirror(mirror: Option<Mirror>) {
    if let Some((mut child, ..)) = mirror {
        unsafe { libc::killpg(child.id() as i32, libc::SIGKILL) };
        let _ = child.wait();
    }
}

/// Starts a mirror in its own group, on pipes: it reads nothing, and its stdin closing ends it.
pub(super) fn start_mirror(m: &Value, cwd: &str) -> io::Result<Mirror> {
    let argv: Vec<&str> = m["argv"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| io::Error::other("empty mirror argv"))?;
    let mut command = Command::new(program);
    command.args(args).env_clear().current_dir(cwd);
    for (k, v) in m["env"].as_object().into_iter().flatten() {
        command.env(k, v.as_str().unwrap_or(""));
    }
    let (child, input, outputs) = spawn_pipes(&mut command, true)?;
    let mut outputs = outputs.into_iter();
    let (_, out) = outputs
        .next()
        .ok_or_else(|| io::Error::other("no stdout"))?;
    // Its stderr is read and dropped, so a chatty mirror never blocks.
    if let Some((_, mut err)) = outputs.next() {
        thread::spawn(move || io::copy(&mut err, &mut io::sink()));
    }
    Ok((
        child,
        input.ok_or_else(|| io::Error::other("no stdin"))?,
        out,
    ))
}
