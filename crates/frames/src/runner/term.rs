//! The terminal side of the runner: waiting out a handoff, and keys and resizes for the live PTY.

use super::{DRAIN, Runner, fail};
use crate::spawn::resize;
use serde_json::{Value, json};
use std::fs::File;
use std::io::Write;
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
