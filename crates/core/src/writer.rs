//! The message writer [D1029]: commit messages, PR text and squash messages, written by a session's
//! own agent on a new conversation of its own, through the adapter's own launch and parse [D43].
//! Each conversation it makes is recorded in the session's `writers` file before anything else
//! happens to it, and forgotten when the reply is in; one that couldn't be is forgotten again by
//! the session's delete, so nothing it leaves outlives the session [D35].

use crate::Spec;
use crate::adapters::{Adapter, Event};
use crate::fold::Fold;
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// How the agents write their own commits, so theirs match the writer's [D1029].
pub const STYLE: &str = "When you write a git commit message, write it the way this repository's recent commits are written. Otherwise: a subject line in the imperative mood of at most 72 characters, then, only when the change needs it, a blank line and a short body wrapped at 72 characters. No trailers.";

/// The writer's rules, after its first line, which says what it writes.
const RULES: &str = "Reply with the message only: a subject line in the imperative mood of at most 72 characters, then, only when the change needs it, a blank line and a short body wrapped at 72 characters. No quotes, no code fences, no trailers. Don't use any tool: everything you need is below.";
/// Proposed: the diff the writer reads is cut after this many characters.
const PATCH_CHARS: usize = 12_000;
/// Proposed: the user's own messages the writer reads, newest first, and each one's length.
const ASKS: usize = 10;
const ASK_CHARS: usize = 500;
/// Proposed: a write gives up after this.
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

/// The repository's latest subjects and the session's own asks, the style and the why [D1029].
fn context(subjects: &[String], asks: &[String]) -> String {
    let mut text = String::new();
    if !subjects.is_empty() {
        text.push_str("\n\nMatch this repository's style: its form, prefixes, tense, capitals and length. Its latest commit subjects:");
        for subject in subjects {
            text.push_str(&format!("\n- {subject}"));
        }
    }
    if !asks.is_empty() {
        text.push_str("\n\nWhat the user asked for in this session, for the why:");
        for ask in asks {
            text.push_str(&format!("\n- {ask}"));
        }
    }
    text
}

fn cut(patch: &str) -> String {
    let shown: String = patch.chars().take(PATCH_CHARS).collect();
    match shown.len() < patch.len() {
        true => format!("{shown}\n[the rest of the diff is cut]"),
        false => shown,
    }
}

/// A commit message's prompt (a squash's too: its patch is the branch's).
pub fn commit_prompt(patch: &str, subjects: &[String], asks: &[String]) -> String {
    format!(
        "Write the commit message for these changes.\n{RULES}{}\n\nThe changes:\n{}",
        context(subjects, asks),
        cut(patch)
    )
}

/// A pull request's prompt: its title on the first line, then its body.
pub fn pr_prompt(patch: &str, commits: &[String], asks: &[String]) -> String {
    format!(
        "Write the pull request's title and body for these changes.\nReply with the title on the first line, of at most 72 characters, then a blank line and the body: a short summary of what changed and why. No quotes, no code fences. Don't use any tool: everything you need is below.{}\n\nThe changes:\n{}",
        context(commits, asks),
        cut(patch)
    )
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

/// The reply as a message: no fences, no wrapping quotes; empty when it said nothing.
fn clean(reply: &str) -> String {
    let lines: Vec<&str> = (reply.trim().lines())
        .filter(|line| !line.trim_start().starts_with("```"))
        .collect();
    (lines.join("\n").trim())
        .trim_matches(|c| c == '"' || c == '`')
        .trim()
        .to_string()
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
pub fn write(a: &dyn Adapter, run: &Spec, account: &str, prompt: &str) -> Result<String, Failure> {
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
    let deadline = Instant::now() + Duration::from_secs(WRITE_SECS);
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
            Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                break Err(format!("{} stopped before it answered", a.label()));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                break Err(format!("{} didn't answer in {WRITE_SECS} s", a.label()));
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
    for (backend, account, id, paths) in left(&spec.dir) {
        let Some(a) = crate::adapters::get(&backend) else {
            continue;
        };
        let run = crate::account::as_run(spec, f, &backend, Some(&account));
        if let Err(e) = remove(a, &run, &id, &paths) {
            stayed.push(format!("{backend} writer: {e}"));
        }
    }
    stayed
}
