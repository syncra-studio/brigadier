//! A scripted agent for the drills. It reads messages from stdin and acts out the directives in
//! them (`tree:600`, `ask`, `limit`, ...), and keeps a ledger outside the app so the drills can
//! count starts, received messages and child deaths without trusting Brigadier's own records.
//! `gen` writes synthetic session logs for the scale drill.

mod control;
mod directives;
mod feedback;
mod generate;
mod tool;

use brigadier_frames::log;
use generate::generate;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::time::Duration;
use std::{env, process, thread};

struct Agent {
    sid: String,
    home: PathBuf,
    tools: u32,
    waiting: bool,
    /// The setup (model, effort, level) its turns run with, and whether a turn has said it yet.
    setup: Value,
    told: bool,
    /// Stdin's lines, and the messages that came while a turn ran, for after it.
    rx: Receiver<Value>,
    backlog: VecDeque<Value>,
    /// Answers to its requests by id, and what the user allowed for this session [D193].
    answers: HashMap<String, Value>,
    grants: HashSet<String>,
    /// The id of the input it is about to act on.
    took: Option<String>,
}

/// The shell the fake's steps run in: /bin/sh, or on Windows Git's `sh` on PATH.
fn sh() -> std::process::Command {
    std::process::Command::new(if cfg!(windows) { "sh" } else { "/bin/sh" })
}

/// `sleep secs` as its own process: /bin/sleep, or on Windows Git's through its `sh`.
fn sleeper(secs: &str) -> std::process::Command {
    match cfg!(windows) {
        true => {
            let mut c = sh();
            c.args(["-c", &format!("exec sleep {secs}")]);
            c
        }
        false => {
            let mut c = std::process::Command::new("/bin/sleep");
            c.arg(secs);
            c
        }
    }
}

/// `c`, out of its group once it starts: a session of its own, or on Windows out of its group's job.
fn own_session(c: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(unix)]
    unsafe {
        std::os::unix::process::CommandExt::pre_exec(c, || {
            (libc::setsid() >= 0)
                .then_some(())
                .ok_or_else(std::io::Error::last_os_error)
        });
    }
    // CREATE_BREAKAWAY_FROM_JOB
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(c, 0x0100_0000);
    c
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

    /// What it remembers of this conversation, one line per turn: what a rewind cuts.
    fn conv(&self) -> Vec<String> {
        fs::read_to_string(self.home.join(format!("{}.conv", self.sid)))
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect()
    }

    /// The message writer's prompt (core's `writer`, D1029): a PR title and description naming the
    /// diff's files, so a PR on Fake reads as one. In the changes, "nowrite" makes it fail and "slow:<ms>" waits, for demos.
    fn write(&mut self, text: &str) {
        emit(json!({"t": "turn"}));
        let words: Vec<&str> = text.split_whitespace().collect();
        if let Some(ms) = words.iter().find_map(|w| w.strip_prefix("slow:")) {
            thread::sleep(Duration::from_millis(ms.parse().unwrap_or(0)));
        }
        if text.contains("nowrite") {
            emit(json!({"t": "fail", "message": "The fake writer was told to fail."}));
            return emit(json!({"t": "done", "ok": false}));
        }
        if feedback::asked(text) {
            self.say(&feedback::reply(text));
            return emit(json!({"t": "done"}));
        }
        let files: Vec<&str> = (text.lines())
            .filter_map(|l| l.strip_prefix("diff --git a/")?.split(" b/").next())
            .take(3)
            .collect();
        let what = match files.is_empty() {
            true => "the files".to_string(),
            false => files.join(", "),
        };
        self.say(&format!("Update {what}\n\nThis updates {what}."));
        emit(json!({"t": "done"}));
    }

    /// A hand-off's `reborn:N:a+b`, while fewer than N fresh conversations acted it: `a b`.
    fn reborn(&self, text: &str) -> Option<String> {
        let word = text
            .split_whitespace()
            .find_map(|w| w.strip_prefix("reborn:"))?;
        let (n, directives) = word.split_once(':')?;
        let count = self.home.join("reborn");
        let done = fs::read_to_string(&count).map_or(0, |c| c.len());
        if done >= n.parse().unwrap_or(0) {
            return None;
        }
        append(&count, "");
        Some(
            directives
                .trim_end_matches(|c: char| !c.is_alphanumeric())
                .replace('+', " "),
        )
    }

    fn handle(&mut self, text: &str) {
        if feedback::asked(text) {
            return self.write(text);
        }
        // Create PR's prompt (cli host.rs `written`), the only one left since the commit's went [D1029].
        if text.starts_with("Write a pull request title") {
            return self.write(text);
        }
        // The bracketed lines Brigadier puts first (another session's name, the night's rules, a
        // note's) are prose, not directives ("Never ask: …").
        let mut body = text;
        while let Some((_, rest)) = body.strip_prefix('[').and_then(|r| r.split_once("]\n\n")) {
            body = rest;
        }
        // A reviewer's brief quotes the work's task: only what the asking session added acts.
        // A plan's review acts on the plan's own words (`exitplan`'s is `approve`).
        if body.starts_with("Adversarial review of ") && body.contains("\n\nThe plan:\n") {
            body = (body.split_once("\n\nThe plan:\n")).map_or("", |(_, p)| {
                p.split_once("\n\nTry to break this plan.")
                    .map_or(p, |p| p.0)
            });
        } else if body.starts_with("Adversarial review of ") {
            body = (body.split_once("From the session that asked for this review:\n"))
                .map_or("", |(_, g)| {
                    g.split_once("\n\nTry to break it.").map_or(g, |g| g.0)
                });
        }
        // A worker's brief: the line Brigadier puts after it is prose too ("To ask it something…").
        let body = body
            .split_once("\n\nYou're a worker for ")
            .map_or(body, |(brief, _)| brief);
        // A worker's result or ask into its parent is prose quoting the worker: nothing in it acts.
        let about_worker =
            text.starts_with("Worker ") && text.lines().next().is_some_and(|l| l.contains(" (w"));
        let body = if about_worker { "" } else { body };
        // A hand-off is prose: only the message after its Next step acts [D88], or what the task's
        // `reborn:N:a+b` asks of its first N fresh conversations: `a b` again [D144].
        let again = (text.contains("\n## Next\n").then(|| self.reborn(text)))
            .flatten()
            .or_else(|| self.summary_mark(text));
        let body = match text.split_once("\n## Next\n") {
            _ if again.is_some() => again.as_deref().unwrap_or(""),
            Some((_, next)) => next.split_once('\n').map_or("", |n| n.1).trim(),
            None => body,
        };
        let first = body.split_whitespace().next().unwrap_or("");
        // Noted as taken before it acts, so a record without the note proves it never did; one it
        // died before acting on is acted on when resumed [D66].
        // Messages a Recover gave back ride ahead of its own words, each in its envelope: each read.
        let back = body
            .split("\n\n[")
            .skip(1)
            .filter_map(|m| m.split_once("]\n\n"));
        let firsts = [first]
            .into_iter()
            .chain(back.filter_map(|m| m.1.split_whitespace().next()));
        let act: Vec<String> = firsts.map(|w| format!("recv {} {w}", self.sid)).collect();
        self.take(None, text, &act.join("\n"));
        self.note(&format!("recv {text}"));
        let words: Vec<&str> = body.split_whitespace().collect();
        // An answer goes on with the waiting turn, acting out its own directives.
        // `slow:N` holds it N ms, a message's start or, typed in an answer, the turn going on [D327].
        let slow = || {
            if let Some(ms) = words.iter().find_map(|w| w.strip_prefix("slow:")) {
                thread::sleep(Duration::from_millis(ms.parse().unwrap_or(0)));
            }
        };
        if self.waiting {
            self.waiting = false;
            slow();
            self.say("thanks for the answer");
        } else {
            if text.contains("noturn") {
                return;
            }
            slow();
            // Refused outright, before any turn: what a CLI at its limit answers to a new message.
            // `refuse:N` says it resets in N seconds.
            let refuse = words.iter().find_map(|w| w.strip_prefix("refuse:"));
            if let Some(secs) = refuse
                .and_then(|n| n.parse::<u64>().ok())
                .filter(|_| limited())
            {
                let resets = now() + secs * 1000;
                emit(
                    json!({"t": "error", "code": 429, "message": "usage limit reached", "resets": resets}),
                );
                return emit(json!({"t": "done", "ok": false}));
            }
            if words.contains(&"refuse") && limited() {
                emit(json!({"t": "error", "code": 429, "message": "usage limit reached"}));
                return emit(json!({"t": "done", "ok": false}));
            }
            if words.contains(&"nofunds") {
                emit(json!({"t": "error", "code": 402, "message": "Insufficient account funds"}));
                return emit(json!({"t": "done", "ok": false}));
            }
            // `FAKE_ONE_START`: one turn start for the process, as Claude's `system/init` gives.
            static STARTED: std::sync::atomic::AtomicBool =
                std::sync::atomic::AtomicBool::new(false);
            let again = STARTED.swap(true, std::sync::atomic::Ordering::Relaxed);
            if !again || env::var_os("FAKE_ONE_START").is_none() {
                emit(json!({"t": "turn"}));
            }
            emit(json!({"t": "mark", "start": self.conv().len().to_string()}));
            append(&self.home.join(format!("{}.conv", self.sid)), text);
            // `FAKE_OVERHEAD`: a CLI's own reading each turn, what it adds by itself plus a third of
            // the conversation's bytes, in a `FAKE_WINDOW` window.
            let num = |k: &str| env::var(k).ok().and_then(|v| v.parse::<u64>().ok());
            if let Some(over) = num("FAKE_OVERHEAD") {
                let conv = fs::metadata(self.home.join(format!("{}.conv", self.sid)));
                let window = num("FAKE_WINDOW");
                let used = over + conv.map_or(0, |m| m.len()) / 3;
                emit(json!({"t": "context", "used": used, "window": window}));
            }
            // A changed setup shows on the turn it reached, as a CLI's own banner would.
            if !self.told {
                self.told = true;
                self.say(&format!("Running with {}", self.setup));
            }
            // Its network down, as a mark in its home names an agent's error, each turn fails so [D339].
            if let Ok(shape) = fs::read_to_string(self.home.join("offline")) {
                return directives::api_error(shape.trim());
            }
            // A mark in its home holding `N` or `N@ms`: its next N turns hit the limit, a carry-on's
            // too, resetting in a minute or at that time [C54].
            let marked = fs::read_to_string(self.home.join("limits")).unwrap_or_default();
            let (n, at) = marked.trim().split_once('@').unwrap_or((marked.trim(), ""));
            if let Some(n) = n.parse::<u64>().ok().filter(|&n| n > 0 && limited()) {
                let _ = fs::write(self.home.join("limits"), format!("{}@{at}", n - 1));
                let at = at.parse().unwrap_or(now() + 60_000);
                return directives::limit_at(at);
            }
        }
        // Directives are lowercase words, so a prompt's own "Retry …" is prose, not a scripted retry.
        // Brigadier's carry-on at a limit's reset is prose too: its "limit" is no directive [C54].
        let carry_on = text.starts_with("[Your usage limit has reset.");
        for word in words.into_iter().filter(|_| !carry_on) {
            let (name, n) = word
                .split_once(':')
                .map_or((word, 0u64), |(a, b)| (a, b.parse().unwrap_or(0)));
            if !self.directive(name, n, word, 0) {
                return;
            }
        }
        // A continuation Brigadier wrote ("[Your last turn stopped early…]") gets a plain reply,
        // not an echo of its first word, which reads as a cut-off answer.
        if let Some(summary) = self.summary_text(text) {
            self.say_summary(&summary);
        } else if first.starts_with('[') || body.is_empty() {
            self.say("Carried on from where I stopped. All done.");
        } else if let Some(last) = text
            .trim_end()
            .lines()
            .last()
            .filter(|_| text.trim().contains('\n'))
        {
            // A message of several lines: its last one quoted, as a long paste's or a file's line [D2007].
            self.say(&format!("ok {first} · last line: {last}"));
        } else {
            self.say(&format!("ok {first}"));
        }
        emit(json!({"t": "mark", "end": self.conv().len().to_string()}));
        emit(json!({"t": "done"}));
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
        setup: Value::Null,
        told: true,
        rx: control::reader(),
        backlog: VecDeque::new(),
        answers: HashMap::new(),
        grants: HashSet::new(),
        took: None,
    };
    agent.backlog.extend(control::left(&agent.home, &agent.sid));
    emit(json!({"t": "hello", "session": agent.sid, "version": "fake 1"}));
    let mut before = vec![];
    while let Some(v) = agent.backlog.pop_front().or_else(|| agent.rx.recv().ok()) {
        if v["setup"].is_object() {
            agent.set_up(&v["setup"]);
            continue;
        }
        // An answer's images come just before it.
        if let Some(images) = v["before"].as_array() {
            before = images.clone();
            continue;
        }
        // A stop while it waits on a question ends that turn; with none open, it means nothing.
        if v["interrupt"] == true {
            if std::mem::take(&mut agent.waiting) {
                agent.stopped(None);
            }
            continue;
        }
        // An answer from the question card: its answers, as if typed.
        let text = match v["answer"]["answers"].as_array() {
            Some(answers) => answers
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", "),
            None => v["text"].as_str().unwrap_or("").to_string(),
        };
        // The images a message carried, named back, so a demo sees them arrive [D2008].
        let before = std::mem::take(&mut before);
        let images: Vec<&str> = (v["images"].as_array().into_iter().flatten())
            .chain(&before)
            .filter_map(|p| p.as_str()?.rsplit('/').next())
            .collect();
        let text = if images.is_empty() {
            text
        } else {
            format!("{text}\n[sees images: {}]", images.join(", "))
        };
        if !text.trim().is_empty() || (agent.waiting && v["answer"]["answers"].is_array()) {
            agent.took = v["id"].as_str().map(String::from);
            agent.handle(&text);
        }
    }
}

/// The limit directives hit only the computer's login, or an account whose home holds `limited`,
/// so a session switched to another account goes on [D51].
fn limited() -> bool {
    env::var_os("FAKE_ACCOUNT").is_none_or(|home| Path::new(&home).join("limited").exists())
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        // A stand-in sign-in for drills and demos: a mark in the account's home, never a secret.
        Some(cmd @ ("login" | "logout")) => {
            let Some(home) = env::var_os("FAKE_ACCOUNT") else {
                eprintln!("{cmd}: only an account (FAKE_ACCOUNT) signs in or out");
                process::exit(1);
            };
            let mark = Path::new(&home).join("login");
            let done = if cmd == "login" {
                fs::write(&mark, "fake\n")
            } else {
                fs::remove_file(&mark)
            };
            match done {
                Ok(()) => println!(
                    "{}",
                    if cmd == "login" {
                        "Signed in."
                    } else {
                        "Signed out."
                    }
                ),
                Err(e) => {
                    eprintln!("{cmd}: {e}");
                    process::exit(1);
                }
            }
        }
        Some("agent") => agent(&args),
        Some("--version") => println!("fake 1"),
        // The `detach` directive's tool: it waits to be found and stopped.
        Some("hold") => thread::sleep(Duration::from_secs(300)),
        // The `mcp` directive's server: a shell step on its own pipes, as long as it runs.
        Some("brigadier") => {
            let secs = env::var("FAKE_MCP_SECS").unwrap_or_else(|_| "300".into());
            let _ = sh().args(["-c", &format!("sleep {secs}")]).status();
        }
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
