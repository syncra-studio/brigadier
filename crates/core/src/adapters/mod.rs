//! One small adapter per backend. Nothing outside this folder names a provider.

mod claude;
mod codex;
mod fake;
mod opencode;

use crate::Spec;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub struct Launch {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Long-lived children read later messages from stdin.
    pub keep_stdin: bool,
    /// Bytes written right after spawn: the first message, for children that read stdin.
    pub input: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum Event {
    TurnStart,
    TurnEnd(bool),
    Text(String),
    Reasoning(String),
    ToolStart(Tool),
    ToolEnd(Done),
    Resume(String),
    Limited(String),
    SignIn(String),
    /// A question to the user: its id (the asking tool call's), the question and its options.
    Question(String, String, Vec<String>),
    /// What the user answered, matched to the question by id; None when the CLI gave up asking.
    Answer(String, Option<String>),
    /// "running" or "done".
    Compaction(&'static str),
    Usage(Value),
    Unknown(String),
}

/// A tool call as it starts. Every field but `id` and `name` is the adapter's reading of it.
#[derive(Debug, PartialEq, Default)]
pub struct Tool {
    pub id: String,
    pub name: String,
    /// read, edit, search, run, web, agent or other; empty for plumbing, which draws no row [D48, D65].
    pub step: &'static str,
    /// What it acts on: a path, a pattern, a URL, a command; otherwise its input as JSON.
    pub input: String,
    /// The subagent call this step runs under, when the CLI streams a subagent's steps [D78].
    pub parent: Option<String>,
    /// Files it changes, as the thread's FileChange, when known at the start.
    pub changes: Vec<Value>,
    /// When the CLI says it started (ms); None means the frame's time.
    pub at: Option<u64>,
}

/// A tool call as it ends.
#[derive(Debug, PartialEq, Default)]
pub struct Done {
    pub id: String,
    pub output: String,
    pub ok: bool,
    pub exit: Option<i64>,
    pub changes: Vec<Value>,
    /// A subagent's own session id.
    pub child: Option<String>,
    pub parent: Option<String>,
    pub at: Option<u64>,
}

pub struct Timing {
    /// Silence shorter than this still reads as working.
    pub silent_ms: u64,
    /// Silence longer than this, with no tool running, reads as stalled.
    pub stall_ms: u64,
    /// A delivered message with no sign of a turn after this reads as not started.
    pub no_start_ms: u64,
}

pub trait Adapter: Sync {
    fn name(&self) -> &'static str;
    fn exe(&self) -> Option<PathBuf>;
    /// True when each turn is its own process; false when one child reads every message.
    fn per_turn(&self) -> bool;
    fn launch(&self, spec: &Spec, resume: Option<&str>, text: Option<&str>) -> Launch;
    /// Bytes for a message to a child that is already running.
    fn encode(&self, spec: &Spec, text: &str) -> String;
    fn parse(&self, line: &str) -> Vec<Event>;
    fn timing(&self) -> Timing;
    /// Files and folders this backend wrote outside the session folder for this session only, by
    /// exact path. Delete removes them entirely.
    fn external(&self, _spec: &Spec, _resume: &str) -> Vec<PathBuf> {
        vec![]
    }
    /// Folders the backend shares with other sessions. Delete removes them only once empty.
    fn shared(&self, _spec: &Spec) -> Vec<PathBuf> {
        vec![]
    }
    /// Removes what `external` can't name, through the backend's own tool. Best effort.
    fn forget(&self, _spec: &Spec, _resume: &str) {}
    /// Assistant texts and tool calls counted from the backend's own transcript.
    fn transcript(&self, _spec: &Spec, _resume: &str) -> Option<(u64, u64)> {
        None
    }
}

pub fn all() -> [&'static dyn Adapter; 4] {
    [
        &fake::Fake,
        &claude::Claude,
        &codex::Codex,
        &opencode::OpenCode,
    ]
}

pub fn get(name: &str) -> Option<&'static dyn Adapter> {
    all().into_iter().find(|a| a.name() == name)
}

/// The environment every child starts from: nothing inherited but the basics.
pub fn base_env(spec: &Spec, exe: &Path) -> Vec<(String, String)> {
    let var = |k: &str| std::env::var(k).unwrap_or_default();
    let dir = exe
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let mut env = vec![
        ("HOME".into(), var("HOME")),
        ("USER".into(), var("USER")),
        ("LANG".into(), "en_US.UTF-8".into()),
        ("TMPDIR".into(), var("TMPDIR")),
        (
            "PATH".into(),
            format!("{dir}:/usr/bin:/bin:/usr/sbin:/sbin"),
        ),
    ];
    if spec.mode == "pty" {
        env.push(("TERM".into(), "xterm-256color".into()));
    }
    env
}

pub fn home_path(rest: &str) -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(rest)
}

/// Text of a JSON line's field, or empty.
pub fn s<'a>(v: &'a Value, path: &[&str]) -> &'a str {
    path.iter().fold(v, |v, k| &v[*k]).as_str().unwrap_or("")
}

/// One changed file in the thread's FileChange shape [D74, D83]: what the CLI didn't report is null.
pub fn change(
    path: &str,
    change: &str,
    diff: Option<String>,
    added: Option<u64>,
    removed: Option<u64>,
) -> Value {
    serde_json::json!({"path": path, "change": change, "from": null, "diff": diff, "added": added, "removed": removed})
}

/// Lines added and removed in a unified diff, file headers left out.
pub fn counts(diff: &str) -> (u64, u64) {
    let count = |c: char, header: &str| {
        diff.lines()
            .filter(|l| l.starts_with(c) && !l.starts_with(header))
            .count() as u64
    };
    (count('+', "+++"), count('-', "---"))
}

/// The step a shell command is and what it acts on, after the old app's rules [D48, D65]: a
/// compound command runs; a plain GET of a public page is web; readers with a path read; listers
/// and searchers search. Shell wrappers and leading `cd … &&` are taken off first.
pub fn shell_step(command: &str) -> (&'static str, String) {
    let command = unwrap_shell(command);
    let probe = command.split(" || ").next().unwrap_or("");
    if probe.contains([';', '&', '|', '<', '>', '`', '$', '(']) {
        return ("run", command);
    }
    let words = words(&command);
    let program = words.first().map_or("", |w| basename(w));
    let rest = || words.iter().skip(1).map(String::as_str);
    let path = rest()
        .rfind(|w| !w.starts_with('-') && !w.starts_with(|c: char| c.is_ascii_digit()))
        .map(String::from);
    let sends = |w: &str| {
        let w = w.split('=').next().unwrap_or("");
        matches!(
            w,
            "-X" | "--request"
                | "-d"
                | "-F"
                | "-T"
                | "--upload-file"
                | "--post-data"
                | "--post-file"
                | "--method"
                | "--body-data"
                | "--body-file"
        ) || w.starts_with("--data")
            || w.starts_with("--form")
    };
    if matches!(program, "curl" | "wget") && !rest().any(sends) {
        let urls: Vec<&str> = rest()
            .filter(|w| w.starts_with("http://") || w.starts_with("https://"))
            .collect();
        if !urls.is_empty() && urls.iter().all(|u| public_host(u)) {
            return ("web", urls[0].to_string());
        }
    }
    match program {
        "rg" if rest().any(|w| w == "--files") => ("search", command),
        "cat" | "head" | "tail" | "nl" | "less" | "more" | "bat" | "wc" | "sed" => match path {
            Some(p) => ("read", p),
            None => ("run", command),
        },
        "ls" | "find" | "tree" | "fd" => ("search", path.unwrap_or(command)),
        "rg" | "grep" | "ag" | "ack" => match rest().find(|w| !w.starts_with('-')) {
            Some(pattern) => ("search", pattern.to_string()),
            None => ("search", command),
        },
        _ => ("run", command),
    }
}

/// `/bin/zsh -lc 'wc -l a.py'` and `cd /tmp/x && wc -l a.py` → `wc -l a.py`.
fn unwrap_shell(command: &str) -> String {
    let mut c = command.trim();
    if let Some((program, rest)) = c.split_once(char::is_whitespace)
        && matches!(basename(program), "sh" | "bash" | "zsh")
        && let Some(body) = rest
            .trim_start()
            .strip_prefix("-lc")
            .or_else(|| rest.trim_start().strip_prefix("-c"))
            .filter(|b| b.starts_with(char::is_whitespace))
    {
        let body = body.trim();
        c = match body.chars().next() {
            Some(q @ ('\'' | '"')) if body.len() >= 2 && body.ends_with(q) => {
                &body[1..body.len() - 1]
            }
            Some('\'' | '"') => &body[1..],
            _ => body,
        };
    }
    let mut c = c.trim();
    while let Some(rest) = c.strip_prefix("cd ") {
        let rest = rest.trim_start();
        let arg_end = match rest.chars().next() {
            Some(q @ ('\'' | '"')) => rest[1..].find(q).map(|i| i + 2),
            _ => rest.find(char::is_whitespace),
        };
        match arg_end.and_then(|i| rest[i..].trim_start().strip_prefix("&&")) {
            Some(next) => c = next.trim_start(),
            None => break,
        }
    }
    c.to_string()
}

/// A simple command's words, quotes removed.
fn words(command: &str) -> Vec<String> {
    let mut out = vec![];
    let mut chars = command.chars().peekable();
    while let Some(&ch) = chars.peek() {
        if ch.is_whitespace() {
            chars.next();
        } else if ch == '\'' || ch == '"' {
            chars.next();
            out.push(chars.by_ref().take_while(|&c| c != ch).collect());
        } else {
            let mut word = String::new();
            while let Some(&c) = chars.peek().filter(|c| !c.is_whitespace()) {
                word.push(c);
                chars.next();
            }
            out.push(word);
        }
    }
    out
}

fn basename(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
}

/// A host on the internet, not this machine or the local network.
fn public_host(url: &str) -> bool {
    let host = url
        .split("://")
        .nth(1)
        .unwrap_or("")
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    let host = host
        .rsplit('@')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    let private = ["127.", "10.", "192.168.", "169.254.", "0."]
        .iter()
        .any(|p| host.starts_with(p))
        || (16..32).any(|n| host.starts_with(&format!("172.{n}.")));
    host.contains('.')
        && !host.ends_with(".local")
        && !host.ends_with(".internal")
        && !private
        && !host.starts_with('[')
}

/// Classifies an error message the way every backend needs: a limit, a sign-in, or neither.
pub fn classify(message: &str) -> Option<Event> {
    let m = message.to_lowercase();
    let limit = [
        "429",
        "rate limit",
        "rate_limit",
        "usage limit",
        "quota",
        "too many requests",
        "overloaded",
    ];
    let auth = [
        "401",
        "403",
        "unauthorized",
        "login",
        "log in",
        "sign in",
        "expired",
        "invalid api key",
        "authentication",
    ];
    if limit.iter().any(|k| m.contains(k)) {
        Some(Event::Limited(message.to_string()))
    } else if auth.iter().any(|k| m.contains(k)) {
        Some(Event::SignIn(message.to_string()))
    } else {
        None
    }
}
