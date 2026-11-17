//! The message writer [D1029]: commit messages and PR text, written by a session's
//! own agent on a new conversation of its own, through the adapter's own launch and parse [D43].
//! Each conversation it makes is recorded in the session's `writers` file before anything else
//! happens to it, and forgotten when the reply is in; one that couldn't be is forgotten again by
//! the session's delete, so nothing it leaves outlives the session [D35].

use crate::Spec;
use crate::adapters::{Adapter, Event};
use crate::fold::Fold;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Proposed: the user's own messages the writer reads, newest first, and each one's length.
const ASKS: usize = 10;
const ASK_CHARS: usize = 500;
/// A write gives up after this; a test prompt sooner [D617].
pub const WRITE_SECS: u64 = 60;
/// Words a failure says when the computer is offline: only then does a local model write [D1029].
const OFFLINE: [&str; 9] = [
    "offline",
    "network",
    "ENOTFOUND",
    "EAI_AGAIN",
    "getaddrinfo",
    "resolve host",
    "ECONNREFUSED",
    "ENETUNREACH",
    "Unable to connect",
];

/// Settings' optional Write with choice; None keeps the session's automatic model rule [D1224].
#[derive(Serialize, Deserialize)]
pub struct Choice {
    pub backend: String,
    pub model: String,
}

pub fn choice(data: &Path) -> std::io::Result<Option<Choice>> {
    let profile: Value = match fs::read(data.join("profile.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    parse_choice(profile["git_writer"].clone())
}

/// Shared validation for the CLI setter and the saved app setting.
pub fn parse_choice(value: Value) -> std::io::Result<Option<Choice>> {
    if value.is_null() {
        return Ok(None);
    }
    let choice: Choice = serde_json::from_value(value)?;
    if crate::adapters::get(&choice.backend).is_none() || choice.model.trim().is_empty() {
        return Err(std::io::Error::other(
            "The chosen message writer needs an available agent and a model.",
        ));
    }
    Ok(Some(choice))
}

/// Why the writer wrote nothing; `offline` when the failure reads as no network.
#[derive(Debug)]
pub struct Failure {
    pub offline: bool,
    pub why: String,
}

fn fail(why: impl Into<String>) -> Failure {
    let why = why.into();
    let offline = OFFLINE
        .iter()
        .any(|w| why.to_lowercase().contains(&w.to_lowercase()));
    Failure { offline, why }
}

/// The user's own messages in the session at `dir`, newest first, each cut short.
pub fn asks(dir: &Path) -> Vec<String> {
    let mut all = vec![];
    let _ = crate::read(dir, |item| {
        if item["kind"] == "input"
            && let Some(text) = item["text"].as_str().filter(|t| !t.trim().is_empty())
        {
            all.push(text.split_whitespace().collect::<Vec<_>>().join(" "));
        }
    });
    all.dedup();
    all.into_iter()
        .rev()
        .take(ASKS)
        .map(|t| match t.chars().count() > ASK_CHARS {
            true => t.chars().take(ASK_CHARS).collect::<String>() + "…",
            false => t,
        })
        .collect()
}

/// Writer text without co-author trailers or generated-with lines [D16].
pub fn without_attribution(message: &str) -> String {
    message
        .lines()
        .filter(|line| {
            let line = line
                .trim()
                .trim_start_matches(['🤖', '*', '_', '[', '>', '-', ' ', '\t'])
                .to_ascii_lowercase();
            !line.starts_with("co-authored-by:") && !line.starts_with("generated with ")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn clean(reply: &str) -> String {
    let lines: Vec<&str> = (reply.trim().lines())
        .filter(|line| !line.trim_start().starts_with("```"))
        .collect();
    without_attribution(
        (lines.join("\n").trim())
            .trim_matches(|c| c == '"' || c == '`')
            .trim(),
    )
}

/// The writer's own folder in the session's: its runs use it as theirs, so an adapter reading a
/// run's folder (its log, its own records) finds only the writer's conversations, never the
/// session's, and removes nothing of the session's [D35].
pub fn home(session: &Path) -> PathBuf {
    session.join("writer")
}

/// The lock a writer run holds shared and a delete takes whole.
pub fn writing(session: &Path) -> std::io::Result<fs::File> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(session.join("writer.lock"))
}

/// Creation takes the session fence briefly; background writing never blocks turn starts.
pub fn hold(session: &Path) -> std::io::Result<fs::File> {
    let _creating = crate::worktrees::lock(session)?;
    // An archived Local checkout can still supply its account for an independent project writer.
    if !session.join("session.json").is_file()
        || crate::session::lifecycle(session).1["op"].is_string()
    {
        return Err(std::io::Error::other(
            "This session is no longer available.",
        ));
    }
    let active = writing(session)?;
    active.lock_shared()?;
    fs::create_dir_all(home(session))?;
    Ok(active)
}

fn records(dir: &Path) -> PathBuf {
    dir.join("writers")
}

/// One line in the session's `writers` file, on disk before the run goes on.
fn note(dir: &Path, line: &Value) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(records(dir))
        .map_err(|e| e.to_string())?;
    writeln!(file, "{line}")
        .and_then(|_| file.sync_data())
        .map_err(|e| e.to_string())
}

/// Removes one writer conversation: the adapter's own forget, then every path it named [D35].
fn remove(a: &dyn Adapter, run: &Spec, id: &str, named: &[String]) -> Result<(), String> {
    crate::check_id(id).map_err(|_| format!("unusual conversation id {id:?}, nothing removed"))?;
    a.forget(run, id)?;
    let paths = (a.external(run, id).into_iter()).chain(named.iter().map(PathBuf::from));
    for path in paths {
        let gone = match path.is_dir() {
            true => fs::remove_dir_all(&path),
            false => fs::remove_file(&path),
        };
        match gone {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(format!("{}: {e}", path.display()));
            }
            _ => {}
        }
    }
    note(&run.dir, &json!({"id": id, "gone": true}))
}

/// One reply from `a` on a new conversation of `run` (its model, effort and account already the
/// writer's), as a clean message. `account`: the account id the run is on, "" for the computer's own.
pub fn write(
    a: &dyn Adapter,
    run: &Spec,
    account: &str,
    prompt: &str,
    _active: &fs::File,
    secs: u64,
) -> Result<String, Failure> {
    fs::create_dir_all(&run.dir).map_err(|e| fail(e.to_string()))?;
    let launch = a.launch(run, None, Some(prompt));
    let (exe, args) = launch
        .argv
        .split_first()
        .ok_or_else(|| fail("no command"))?;
    let mut child = Command::new(exe)
        .args(args)
        .env_clear()
        .envs(launch.env)
        .current_dir(&run.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| fail(format!("{} didn't start: {e}", a.label())))?;
    let mut stdin = child.stdin.take();
    if let (Some(input), Some(pipe)) = (&launch.input, stdin.as_mut()) {
        let _ = pipe.write_all(input.as_bytes());
    }
    let (tx, rx) = mpsc::channel::<Option<String>>();
    for pipe in [
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                if tx.send(Some(line)).is_err() {
                    return;
                }
            }
            let _ = tx.send(None);
        });
    }
    drop(tx);
    let deadline = Instant::now() + Duration::from_secs(secs);
    let (mut id, mut named, mut said, mut text) = (None::<String>, vec![], vec![], String::new());
    let mut ended = 0;
    let outcome: Result<(), String> = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let line = match rx.recv_timeout(left) {
            Ok(Some(line)) => line,
            Ok(None) if ended == 0 => {
                ended += 1;
                continue;
            }
            // What it said goes with it, so an offline failure still reads as one.
            Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                break Err(format!(
                    "{} stopped before it answered\n{}",
                    a.label(),
                    said.join("\n")
                ));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let late = format!("{} didn't answer in {secs} s", a.label());
                break Err(format!("{late}\n{}", said.join("\n")));
            }
        };
        let events = a.parse(&line);
        if events.iter().all(|e| matches!(e, Event::Unknown(_))) && said.len() < 20 {
            said.push(line);
        }
        let mut done = None;
        for event in events {
            match event {
                Event::Resume(conv) if id.as_deref() != Some(&conv) => {
                    // Recorded before anything else, so a crash from here still leaves its trace.
                    let line = json!({"backend": a.name(), "account": account, "id": conv});
                    if let Err(e) = note(&run.dir, &line) {
                        done = Some(Err(e));
                    }
                    id = Some(conv);
                }
                Event::External(path) => {
                    let _ = note(&run.dir, &json!({"id": id, "external": path}));
                    named.push(path);
                }
                Event::Text(t) if !t.trim().is_empty() => text = t,
                Event::TurnEnd(true) => done = Some(Ok(())),
                Event::TurnEnd(false) => done = Some(Err(said.join("\n"))),
                Event::Approval(_) | Event::Question(_) => {
                    done = Some(Err("it asked to use a tool".into()))
                }
                Event::Limited(why, _)
                | Event::SignIn(why)
                | Event::Unresumable(why)
                | Event::Failed(_, why) => said.push(why),
                Event::OutOfCredits => said.push("no credits left".into()),
                _ => {}
            }
        }
        if let Some(done) = done {
            break done;
        }
    };
    drop(stdin);
    unsafe { libc::killpg(child.id() as i32, libc::SIGKILL) };
    let _ = child.wait();
    // Its conversation goes now; one that won't stays in the record for the session's delete.
    if let Some(id) = &id {
        let _ = remove(a, run, id, &named);
    }
    outcome.map_err(fail)?;
    let message = clean(&text);
    if message.is_empty() {
        return Err(fail(format!("{} replied nothing", a.label())));
    }
    Ok(message)
}

/// The writer conversations of the session at `dir` not yet removed: (backend, account, id, paths).
fn left(dir: &Path) -> Vec<(String, String, String, Vec<String>)> {
    let Ok(text) = fs::read_to_string(records(dir)) else {
        return vec![];
    };
    let lines: Vec<Value> = (text.lines())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let s = |v: &Value, k: &str| v[k].as_str().unwrap_or("").to_string();
    (lines.iter())
        .filter(|v| v["backend"].is_string())
        .filter(|v| {
            !lines
                .iter()
                .any(|g| g["gone"] == true && g["id"] == v["id"])
        })
        .map(|v| {
            let paths = (lines.iter())
                .filter(|e| e["id"] == v["id"] && e["external"].is_string())
                .map(|e| s(e, "external"))
                .collect();
            (s(v, "backend"), s(v, "account"), s(v, "id"), paths)
        })
        .collect()
}

/// For delete: removes every writer conversation still recorded; what couldn't go, said, which
/// keeps the session to try again [D35].
pub fn forget(spec: &Spec, f: &Fold) -> Vec<String> {
    let mut stayed = vec![];
    // Runs under way finish first, so each is recorded and found here; none starts after.
    let _held = match writing(&spec.dir).and_then(|file| file.lock().map(|()| file)) {
        Ok(file) => file,
        Err(e) => return vec![format!("writer: {e}")],
    };
    for (backend, account, id, paths) in left(&home(&spec.dir)) {
        let Some(a) = crate::adapters::get(&backend) else {
            continue;
        };
        let mut run = crate::account::as_run(spec, f, &backend, Some(&account));
        run.dir = home(&spec.dir);
        if let Err(e) = remove(a, &run, &id, &paths) {
            stayed.push(format!("{backend} writer: {e}"));
        }
    }
    stayed
}
