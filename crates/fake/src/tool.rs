//! A directive's tool run, its heartbeat, and the progress a resumed session picks up from.

use super::{Agent, emit, ledger, now};
use serde_json::json;
use std::fs;
use std::process::Stdio;
use std::thread;
use std::time::{Duration, Instant};

impl Agent {
    /// `mcp:N`: a step during which its CLI starts an MCP server, its own `brigadier mcp-server`
    /// line, which runs `sleep N` through the shell on its pipes [D114].
    pub(super) fn mcp(&mut self, n: u64) {
        self.tools += 1;
        let id = format!("tl{}-{}", self.tools, now());
        emit(json!({"t": "tool", "id": id, "name": "shell", "command": "use the MCP server"}));
        let server = std::process::Command::new(std::env::current_exe().unwrap_or_default())
            .args(["brigadier", "mcp-server"])
            .env("FAKE_MCP_SECS", n.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        emit(json!({"t": "tool_done", "id": id, "ok": server.is_ok()}));
        // On its own pipes, as a CLI keeps its MCP servers, for as long as it runs.
        std::mem::forget(server);
    }

    /// Runs `cmd` as a tool for up to `secs`, with a heartbeat each second unless `quiet`. Progress
    /// is saved, so a resumed session continues what is left rather than starting over.
    /// False when the user stopped the turn inside it.
    pub(super) fn tool(
        &mut self,
        directive: &str,
        secs: u64,
        done_before: u64,
        quiet: bool,
        cmd: &str,
    ) -> bool {
        self.tools += 1;
        let id = format!("tl{}-{}", self.tools, now());
        self.note(&format!("tool {directive}"));
        emit(json!({"t": "tool", "id": id, "name": directive}));
        let mut child = match super::sh()
            .arg("-c")
            .arg(cmd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                self.say(&format!("tool failed: {e}"));
                return true;
            }
        };
        ledger(&format!(
            "child {} {} {} start_us={}",
            self.sid,
            child.id(),
            now() + secs.saturating_sub(done_before) * 1000,
            brigadier_frames::procs::info(child.id() as i32).map_or(0, |p| p.start_us)
        ));
        if !quiet {
            emit(json!({"t": "child", "pid": child.id()}));
        }
        let started = Instant::now();
        let mut beat = 0;
        loop {
            if let Ok(Some(_)) = child.try_wait() {
                break;
            }
            if self.poll() {
                return self.stopped(Some(&mut child));
            }
            thread::sleep(Duration::from_millis(250));
            let elapsed = started.elapsed().as_secs();
            if elapsed > beat {
                beat = elapsed;
                self.note(&format!("progress {directive} {}", done_before + elapsed));
                if !quiet {
                    emit(json!({"t": "beat", "n": beat}));
                }
            }
        }
        ledger(&format!("child_done {}", child.id()));
        self.note(&format!("finished {directive}"));
        emit(json!({"t": "tool_done", "id": id}));
        true
    }

    /// The last tool that started but never finished, with the seconds it already ran.
    pub(super) fn pending(&self) -> Option<(String, u64)> {
        let text = fs::read_to_string(self.home.join(format!("{}.log", self.sid))).ok()?;
        let mut pending = None;
        for line in text.lines() {
            let mut parts = line.split(' ');
            match (parts.next(), parts.next(), parts.next()) {
                (Some("tool"), Some(d), _) => pending = Some((d.to_string(), 0)),
                (Some("progress"), Some(_), Some(n)) => {
                    pending = pending.map(|(d, _)| (d, n.parse().unwrap_or(0)))
                }
                (Some("finished"), _, _) => pending = None,
                _ => {}
            }
        }
        pending
    }
}
