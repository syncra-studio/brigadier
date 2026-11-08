//! A scripted agent for the drills. It reads messages from stdin and acts out the directives in
//! them (`tree:600`, `ask`, `limit`, ...), and keeps a ledger outside the app so the drills can
//! count starts, received messages and child deaths without trusting Brigadier's own records.
//! `gen` writes synthetic session logs for the scale drill.

use brigadier_frames::log;
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::{env, process, thread};

struct Agent {
    sid: String,
    home: PathBuf,
    tools: u32,
    waiting: bool,
}

fn now() -> u64 {
    log::now_ms()
}

fn append(path: &Path, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(format!("{line}\n").as_bytes());
    }
}

fn ledger(line: &str) {
    if let Some(path) = env::var_os("FAKE_LEDGER") {
        append(Path::new(&path), &format!("{line} {}", now()));
    }
}

/// Writes one frame line. A closed stdout means our owner is gone: exit, as a real CLI would.
fn out(bytes: &[u8]) {
    let mut stdout = io::stdout().lock();
    if stdout
        .write_all(bytes)
        .and_then(|_| stdout.write_all(b"\n"))
        .and_then(|_| stdout.flush())
        .is_err()
    {
        process::exit(3);
    }
}

fn emit(v: Value) {
    out(v.to_string().as_bytes());
}

impl Agent {
    fn note(&self, line: &str) {
        append(&self.home.join(format!("{}.log", self.sid)), line);
    }

    fn say(&self, text: &str) {
        self.note(&format!("say {text}"));
        emit(json!({"t": "say", "text": text}));
    }

    /// Runs `cmd` as a tool for up to `secs`, with a heartbeat each second unless `quiet`. Progress
    /// is saved, so a resumed session continues what is left rather than starting over.
    fn tool(&mut self, directive: &str, secs: u64, done_before: u64, quiet: bool, cmd: &str) {
        self.tools += 1;
        let id = format!("tl{}-{}", self.tools, now());
        self.note(&format!("tool {directive}"));
        emit(json!({"t": "tool", "id": id, "name": directive}));
        let mut child = match Command::new("/bin/sh")
            .arg("-c")
            .arg(cmd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => return self.say(&format!("tool failed: {e}")),
        };
        ledger(&format!(
            "child {} {} {}",
            self.sid,
            child.id(),
            now() + secs.saturating_sub(done_before) * 1000
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
    }

    /// The last tool that started but never finished, with the seconds it already ran.
    fn pending(&self) -> Option<(String, u64)> {
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

    fn handle(&mut self, text: &str) {
        let first = text.split_whitespace().next().unwrap_or("");
        ledger(&format!("recv {} {first}", self.sid));
        self.note(&format!("recv {text}"));
        let words: Vec<&str> = text.split_whitespace().collect();
        // An answer goes on with the waiting turn, acting out its own directives.
        if self.waiting {
            self.waiting = false;
            self.say("thanks for the answer");
        } else {
            if text.contains("noturn") {
                return;
            }
            if let Some(ms) = words.iter().find_map(|w| w.strip_prefix("slow:")) {
                thread::sleep(Duration::from_millis(ms.parse().unwrap_or(0)));
            }
            emit(json!({"t": "turn"}));
        }
        for word in words {
            let word = word.to_lowercase();
            let word = word.as_str();
            let (name, n) = word
                .split_once(':')
                .map_or((word, 0u64), |(a, b)| (a, b.parse().unwrap_or(0)));
            if !self.directive(name, n, word, 0) {
                return;
            }
        }
        self.say(&format!("ok {first}"));
        emit(json!({"t": "done"}));
    }

    /// Acts out one directive. False when the turn ended inside it.
    fn directive(&mut self, name: &str, n: u64, word: &str, done_before: u64) -> bool {
        let left = n.saturating_sub(done_before);
        match name {
            "say" => (0..n).for_each(|i| self.say(&format!("line {i}"))),
            "tree" => self.tool(
                word,
                n,
                done_before,
                false,
                &format!("sleep {left} & sleep {left} & wait"),
            ),
            "tool_sleep" => self.tool(word, n, done_before, true, &format!("sleep {left}")),
            "cargo" => {
                let cargo = env::var("FAKE_CARGO").unwrap_or_else(|_| "cargo".into());
                let manifest = env::var("FAKE_CARGO_MANIFEST").unwrap_or_default();
                let target = self.home.join("target");
                let cmd = format!(
                    "end=$(( $(date +%s) + {left} )); while [ $(date +%s) -lt $end ]; do nice -n 15 '{cargo}' build -q --offline -j1 --manifest-path '{manifest}' --target-dir '{}' >/dev/null 2>&1; '{cargo}' clean -q --offline --manifest-path '{manifest}' --target-dir '{}' >/dev/null 2>&1; done",
                    target.display(),
                    target.display()
                );
                self.tool(word, n, done_before, false, &cmd);
            }
            "hang" => thread::sleep(Duration::from_secs(n)),
            "ask" => {
                self.waiting = true;
                emit(json!({"t": "ask", "text": "Proceed with the change?"}));
                return false;
            }
            "limit" => {
                emit(
                    json!({"t": "error", "code": 429, "message": "rate limited, try again in 60s"}),
                );
                emit(json!({"t": "done", "ok": false}));
                return false;
            }
            "auth" => {
                emit(json!({"t": "error", "code": 401, "message": "login expired"}));
                emit(json!({"t": "done", "ok": false}));
                return false;
            }
            "compact" => emit(json!({"t": "compact"})),
            "unknown" => {
                emit(json!({"t": "mystery", "x": 1}));
                out(b"garbage <<<");
            }
            "badutf8" => out(&[0xff, 0xfe, b'o', b'k']),
            "bigline" => out(json!({"t": "say", "text": "x".repeat((n << 20) as usize)})
                .to_string()
                .as_bytes()),
            "bg" => drop(
                Command::new("/bin/sleep")
                    .arg(n.to_string())
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn(),
            ),
            "escape" => unsafe {
                drop(
                    Command::new("/bin/sleep")
                        .arg("300")
                        .stdout(Stdio::null())
                        .pre_exec(|| {
                            (libc::setsid() >= 0)
                                .then_some(())
                                .ok_or_else(io::Error::last_os_error)
                        })
                        .spawn(),
                );
            },
            "exit" => process::exit(n as i32),
            "continue" => {
                if let Some((d, done)) = self.pending() {
                    let (name, n) = d
                        .split_once(':')
                        .map_or((d.as_str(), 0), |(a, b)| (a, b.parse().unwrap_or(0)));
                    let name = name.to_string();
                    return self.directive(&name, n, &d, done);
                }
            }
            _ => {}
        }
        true
    }
}

fn agent(args: &[String]) {
    let flag = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let home = PathBuf::from(flag("--home").unwrap_or_else(|| ".".into()));
    let _ = fs::create_dir_all(&home);
    let sid = flag("--resume").unwrap_or_else(|| format!("fk{:x}{}", now(), process::id()));
    ledger(&format!("start {} {sid}", process::id()));
    let mut agent = Agent {
        sid,
        home,
        tools: 0,
        waiting: false,
    };
    emit(json!({"t": "hello", "session": agent.sid, "version": "fake 1"}));
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim_end_matches('\r');
        let text = serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|v| v["text"].as_str().map(String::from))
            .unwrap_or_else(|| line.to_string());
        if !text.trim().is_empty() {
            agent.handle(&text);
        }
    }
}

/// Writes a synthetic session of about `bytes` bytes: many turns of realistic agent output.
fn generate(dir: &Path, id: &str, bytes: u64) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let spec = json!({"id": id, "backend": "fake", "mode": "pipe", "cwd": "/tmp", "model": null, "opts": {}, "created": now()});
    fs::write(dir.join("session.json"), spec.to_string())?;
    let mut w = log::Writer::open(&dir.join("log"))?;
    let spawned = json!({"pid": 999_999, "pgid": 999_999, "start_us": 1, "backend": "fake", "mode": "pipe", "cli_version": "fake 1"});
    w.append(log::SPAWNED, spawned.to_string().as_bytes(), false)?;
    w.append(
        log::OUT,
        format!("{}\n", json!({"t": "hello", "session": format!("fk{id}")})).as_bytes(),
        false,
    )?;
    let filler = "lorem ipsum dolor sit amet ".repeat(8);
    let mut turn = 0u64;
    while w.len < bytes {
        let cid = format!("g{turn}");
        w.append(log::INTENT, json!({"cid": cid, "origin": "user", "text": format!("message {turn}"), "backend": "fake"}).to_string().as_bytes(), false)?;
        w.append(
            log::DELIVERED,
            json!({"cid": cid}).to_string().as_bytes(),
            false,
        )?;
        let mut chunk = format!("{}\n", json!({"t": "turn"}));
        for i in 0..40 {
            chunk += &format!("{}\n", json!({"t": "say", "text": format!("{i} {filler}")}));
            if i % 10 == 0 {
                chunk += &format!(
                    "{}\n{}\n",
                    json!({"t": "tool", "id": format!("t{turn}-{i}"), "name": "tree"}),
                    json!({"t": "beat", "n": 1})
                );
                chunk += &format!(
                    "{}\n",
                    json!({"t": "tool_done", "id": format!("t{turn}-{i}")})
                );
            }
            if chunk.len() > 8 << 10 {
                w.append(log::OUT, chunk.as_bytes(), false)?;
                chunk.clear();
            }
        }
        chunk += &format!("{}\n", json!({"t": "done"}));
        w.append(log::OUT, chunk.as_bytes(), false)?;
        turn += 1;
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("agent") => agent(&args),
        Some("--version") => println!("fake 1"),
        Some("gen") => {
            let (dir, bytes) = (PathBuf::from(&args[1]), args[2].parse().unwrap_or(1 << 20));
            let id = dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            if let Err(e) = generate(&dir, &id, bytes) {
                eprintln!("gen: {e}");
                process::exit(1);
            }
        }
        _ => eprintln!("usage: brigadier-fake agent --home DIR [--resume ID] | gen DIR BYTES"),
    }
}
