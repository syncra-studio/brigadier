//! Stopping a session's work: every process group it started, whatever holds the input lock.

use super::{Groups, Runner};
use crate::{log, procs};
use serde_json::{Value, json};
use std::io;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::{Duration, Instant};

impl Runner {
    /// Advances a handoff's guard past only its own stop and the replaced child's exit.
    pub(super) fn handoff_len(&self, len: u64, pid: i32, stops: u64) -> io::Result<u64> {
        let log = self.log.lock().unwrap();
        let mut reader = log::Reader::open(&self.dir.join("log"), len, 0)?;
        let stopped = reader.frame()?.is_some_and(|f| {
            f.kind == log::STOPPED
                && serde_json::from_slice::<Value>(&f.data).is_ok_and(|v| v["by"] == "handoff")
        });
        let exited = reader.frame()?.is_some_and(|f| {
            f.kind == log::EXITED
                && serde_json::from_slice::<Value>(&f.data).is_ok_and(|v| v["pid"] == pid)
        });
        if !stopped
            || !exited
            || reader.pos != log.len
            || self.stops.load(Ordering::SeqCst) != stops
        {
            return Err(io::Error::other("changed"));
        }
        Ok(log.len)
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
