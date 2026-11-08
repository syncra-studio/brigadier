//! What reaches the fake agent besides a message, mid-turn as between turns: its setup, answers to
//! its requests, a steer and a stop, read from stdin by a thread of their own [D159].

use super::{Agent, emit, ledger, now};
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::io::{self, BufRead};
use std::process::Child;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

/// Each stdin line as JSON; a plain line (typed in its terminal) as `{"text"}`.
pub fn reader() -> Receiver<Value> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let line = line.trim_end_matches('\r');
            let v = serde_json::from_str::<Value>(line)
                .ok()
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({"text": line}));
            if tx.send(v).is_err() {
                break;
            }
        }
    });
    rx
}

impl Agent {
    /// Takes what came in since: true when it was a stop. Messages wait for the turn to end.
    pub fn poll(&mut self) -> bool {
        while let Ok(v) = self.rx.try_recv() {
            if v["interrupt"] == true {
                return true;
            } else if v["setup"].is_object() {
                self.set_up(&v["setup"]);
            } else if v["answer"].is_object() {
                let id = v["answer"]["id"].as_str().unwrap_or("").to_string();
                self.answers.insert(id, v["answer"].clone());
            } else if v["steer"] == true {
                let text = v["text"].as_str().unwrap_or("");
                ledger(&format!("recv {} {text}", self.sid));
                self.say(&format!("Steered: {text}"));
            } else {
                self.backlog.push_back(v);
            }
        }
        false
    }

    pub fn set_up(&mut self, setup: &Value) {
        // Only a change shows: the setup it started with is no news.
        self.told = self.told && (self.setup.is_null() || self.setup == *setup);
        self.setup = setup.clone();
    }

    /// The turn ends at the user's stop, the agent staying alive, as a CLI's own interrupt does.
    pub fn stopped(&mut self, child: Option<&mut Child>) -> bool {
        if let Some(child) = child {
            for p in procs::descendants(&procs::all(), child.id() as i32) {
                unsafe { libc::kill(p.pid, libc::SIGKILL) };
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        self.say("Stopped.");
        emit(json!({"t": "done", "ok": false}));
        false
    }

    /// `approve:N`: asks to run a command unless its level is full or the session allowed it, then
    /// waits for the answer, or gives the request up after N seconds (0 waits on) [D159, D193].
    pub fn approve(&mut self, give_up: u64) -> bool {
        let (command, pattern) = ("make clean", "make");
        if self.setup["level"] != "full" && !self.grants.contains(pattern) {
            self.tools += 1;
            let id = format!("ap{}-{}", self.tools, now());
            emit(json!({"t": "approve", "id": id, "command": command, "pattern": pattern}));
            let started = Instant::now();
            let answer = loop {
                if self.poll() {
                    return self.stopped(None);
                }
                if let Some(a) = self.answers.remove(&id) {
                    break a;
                }
                if give_up > 0 && started.elapsed().as_secs() >= give_up {
                    emit(json!({"t": "resolved", "id": id}));
                    self.say("Stopped waiting for approval.");
                    return true;
                }
                thread::sleep(Duration::from_millis(100));
            };
            match answer["decision"].as_str() {
                Some("deny") => {
                    let why = answer["reason"].as_str().filter(|r| !r.is_empty());
                    let why = why.map(|r| format!(": {r}")).unwrap_or_default();
                    self.say(&format!("Didn't run {command}{why}."));
                    return true;
                }
                Some("allowSession") => drop(self.grants.insert(pattern.into())),
                _ => {}
            }
        }
        self.tools += 1;
        let id = format!("tl{}-{}", self.tools, now());
        emit(json!({"t": "tool", "id": id, "name": command}));
        emit(json!({"t": "tool_done", "id": id}));
        self.say(&format!("Ran {command}."));
        true
    }
}
