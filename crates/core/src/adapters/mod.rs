//! One small adapter per backend. Nothing outside this folder names a provider.

mod claude;
mod codex;
mod fake;
mod files;
mod opencode;
pub mod setup;

pub use files::{drop_lines, file_lines, uuid};

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
    /// A prompt the CLI took in its own terminal: its id in the CLI's record, and its text [D47].
    Prompt(String, String),
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
    /// Thread `resume`'s turn `turn` (from 0) from the backend's own record: each file edit in
    /// order, as (path, unified diff) per file. None when there's no such record or turn.
    fn diffs(&self, _resume: &str, _turn: u64) -> Option<Vec<Vec<(String, String)>>> {
        None
    }
    /// The CLI's interactive mode on this conversation, and the conversation id it will write
    /// (a new one when `resume` is None and the CLI lets us pick it). None: no terminal [D47].
    fn terminal(&self, _spec: &Spec, _resume: Option<&str>) -> Result<(Launch, String), String> {
        Err("This CLI has no terminal.".into())
    }
    /// Where the CLI's record of `conv` ends now: the mirror starts reading there. None: the
    /// backend keeps no record a mirror can read, so its terminal's work stays in the terminal.
    fn mirror_from(&self, _spec: &Spec, _conv: &str) -> Option<String> {
        None
    }
    /// New lines of the CLI's record after `cursor`, for `parse`, and the cursor after them. Only
    /// whole entries, oldest first; read-only.
    fn mirror(&self, _spec: &Spec, _conv: &str, cursor: &str) -> (Vec<String>, String) {
        (vec![], cursor.into())
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

/// The environment every child starts from: nothing inherited but the basics, and the login
/// shell's PATH after the CLI's own folder, so the user's hooks and tools are found.
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
        ("PATH".into(), format!("{dir}:{}", setup::login().path)),
    ];
    if spec.mode == "pty" {
        env.push(("TERM".into(), "xterm-256color".into()));
    }
    env
}

/// The session's spec, run in a terminal: what each adapter's PTY launch reads.
pub fn in_pty(spec: &Spec) -> Spec {
    Spec {
        mode: "pty".into(),
        ..spec.clone()
    }
}

/// A message typed into a TUI: a bracketed paste, so its newlines stay text, then Enter.
pub fn paste(text: &str) -> String {
    format!("\x1b[200~{}\x1b[201~\r", text.replace('\x1b', ""))
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
    let diff = diff.map(|d| hunks(&d)).filter(|d| !d.is_empty());
    serde_json::json!({"path": path, "change": change, "from": null, "diff": diff, "added": added, "removed": removed})
}

/// A unified diff's hunks alone: the file headers (`Index:`, `===`, `---`, `+++`) dropped.
fn hunks(diff: &str) -> String {
    let mut hunk = false;
    let mut out = String::new();
    for line in diff.lines() {
        if line.starts_with("@@") {
            hunk = true;
        } else if line.starts_with("diff ") || line.starts_with("Index: ") {
            hunk = false;
        }
        if hunk {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Lines added and removed in a unified diff: only lines inside hunks, so file headers don't count
/// and a `+++counter` line does.
pub fn counts(diff: &str) -> (u64, u64) {
    let (mut added, mut removed, mut hunk) = (0, 0, false);
    for line in diff.lines() {
        if line.starts_with("@@") {
            hunk = true;
        } else if line.starts_with("diff ") || line.starts_with("Index: ") {
            hunk = false;
        } else if hunk && line.starts_with('+') {
            added += 1;
        } else if hunk && line.starts_with('-') {
            removed += 1;
        }
    }
    (added, removed)
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
        "rg" | "grep" | "ag" | "ack" => match pattern(&words[1..]) {
            Some(pattern) => ("search", pattern.to_string()),
            None => ("search", command),
        },
        _ => ("run", command),
    }
}

/// A search's pattern: its `-e` value, else its first word that is neither an option nor an
/// option's value.
fn pattern(args: &[String]) -> Option<&str> {
    let mut args = args.iter().map(String::as_str);
    while let Some(w) = args.next() {
        match w {
            "-e" | "--regexp" => return args.next(),
            "-g" | "--glob" | "--iglob" | "-t" | "--type" | "-T" | "--type-not" | "-m"
            | "--max-count" | "-A" | "-B" | "-C" | "--after-context" | "--before-context"
            | "--context" | "-d" | "--max-depth" | "-f" | "--file" | "--include" | "--exclude"
            | "-M" | "--max-columns" | "-j" | "--threads" => {
                args.next();
            }
            w if w.starts_with('-') => {}
            w => return Some(w),
        }
    }
    None
}

/// `/bin/zsh -lc 'wc -l a.py'` and `cd /tmp/x && wc -l a.py` → `wc -l a.py`.
fn unwrap_shell(command: &str) -> String {
    let mut c = command.trim().to_string();
    if let Some((program, rest)) = c.split_once(char::is_whitespace)
        && matches!(basename(program), "sh" | "bash" | "zsh")
        && let Some(body) = rest
            .trim_start()
            .strip_prefix("-lc")
            .or_else(|| rest.trim_start().strip_prefix("-c"))
            .filter(|b| b.starts_with(char::is_whitespace))
    {
        // The script is the shell's next word, its quotes undone as the shell would.
        c = words(body).into_iter().next().unwrap_or_default();
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

/// A simple command's words, quotes and backslashes undone as the shell does; an unclosed quote
/// runs to the end.
fn words(command: &str) -> Vec<String> {
    let mut out = vec![];
    let mut chars = command.chars().peekable();
    loop {
        while chars.next_if(|c| c.is_whitespace()).is_some() {}
        if chars.peek().is_none() {
            return out;
        }
        let mut word = String::new();
        while let Some(c) = chars.next_if(|c| !c.is_whitespace()) {
            match c {
                '\'' => word.extend(chars.by_ref().take_while(|&c| c != '\'')),
                '"' => {
                    while let Some(c) = chars.next().filter(|&c| c != '"') {
                        match chars.next_if(|&n| c == '\\' && matches!(n, '"' | '\\' | '$' | '`')) {
                            Some(n) => word.push(n),
                            None => word.push(c),
                        }
                    }
                }
                '\\' => word.extend(chars.next()),
                c => word.push(c),
            }
        }
        out.push(word);
    }
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
