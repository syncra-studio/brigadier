//! What reaches the fake agent besides a message, mid-turn as between turns: its setup, answers to
//! its requests, a steer and a stop, read from stdin by a thread of their own [D159].

use super::{Agent, emit, ledger, now};
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::io::{self, BufRead};
use std::path::Path;
use std::process;
use std::process::Child;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

/// The input a conversation's record shows taken but that died before acting on it: a resumed
/// conversation holds it, as a CLI's transcript does, so it's acted on first [D66]. Its act is
/// the ledger's line, so one there since it was taken was acted on already.
pub fn left(home: &Path, sid: &str) -> Option<Value> {
    let taking = home.join(format!("{sid}.taking"));
    let v: Value = serde_json::from_str(&fs::read_to_string(&taking).ok()?).ok()?;
    let _ = fs::remove_file(taking);
    let log = fs::read_to_string(home.join(format!("{sid}.log"))).ok()?;
    let took = format!("took {}", v["id"].as_str()?);
    let at = v["at"].as_u64().unwrap_or(0) as usize;
    let acted = (ledger_at().and_then(|p| fs::read(p).ok())).is_some_and(|b| {
        let since = String::from_utf8_lossy(b.get(at..).unwrap_or_default()).into_owned();
        since
            .lines()
            .any(|l| l.starts_with(&format!("recv {sid} ")))
    });
    (log.lines().any(|l| l == took) && !acted).then_some(v)
}

fn ledger_at() -> Option<std::ffi::OsString> {
    std::env::var_os("FAKE_LEDGER")
}

/// Each stdin line as JSON.
pub fn reader() -> Receiver<Value> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Some(v) = serde_json::from_str::<Value>(&line)
                .ok()
                .filter(Value::is_object)
            else {
                continue;
            };
            if tx.send(v).is_err() {
                break;
            }
        }
    });
    rx
}

impl Agent {
    /// Notes that it took input `id`, in its record, before acting on it (`act`, its ledger line):
    /// a note it can't write stops it, so a record without it proves it never took that input.
    /// Then says so on its output, as a CLI's ack, last: that write is what kills it once its host
    /// is gone. `text` waits beside the note until it's acted on, for `left` [D66].
    pub fn take(&mut self, id: Option<String>, text: &str, act: &str) {
        let Some(id) = id.or_else(|| self.took.take()) else {
            return act.lines().for_each(ledger);
        };
        let taking = self.home.join(format!("{}.taking", self.sid));
        let at = ledger_at()
            .and_then(|p| fs::metadata(p).ok())
            .map_or(0, |m| m.len());
        let _ = fs::write(
            &taking,
            json!({"id": id, "text": text, "at": at}).to_string(),
        );
        let path = self.home.join(format!("{}.log", self.sid));
        let noted = OpenOptions::new().create(true).append(true).open(path);
        let noted = noted.and_then(|mut f| {
            f.write_all(format!("took {id}\n").as_bytes())
                .and_then(|_| f.sync_data())
        });
        if noted.is_err() {
            process::exit(4);
        }
        act.lines().for_each(ledger);
        let _ = fs::remove_file(taking);
        emit(json!({"t": "took", "id": id}));
    }

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
            } else if v["steer"] == true
                && v["text"]
                    .as_str()
                    .is_some_and(|t| t.contains("refuse_steer"))
            {
                // Refused unread, as a CLI whose turn ended before it read a steer answers [D66].
                emit(
                    json!({"t": "took", "id": v["id"], "error": "The turn ended before it read this."}),
                );
            } else if v["steer"] == true {
                let text = v["text"].as_str().unwrap_or("");
                let act = format!("recv {} {text}", self.sid);
                self.take(v["id"].as_str().map(String::from), text, &act);
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
