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
    ToolStart(String, String),
    ToolEnd(String),
    Resume(String),
    Limited(String),
    SignIn(String),
    Question(String),
    Compaction,
    Usage(Value),
    Unknown(String),
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
