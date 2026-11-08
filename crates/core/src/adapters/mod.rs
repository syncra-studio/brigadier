//! One small adapter per backend. Nothing outside this folder names a provider.

mod claude;
mod codex;
mod fake;
mod files;
mod opencode;
pub mod setup;
mod shell;

pub use shell::{shell_step, unwrap_shell};

pub use files::{change, counts, drop_lines, sha1, uuid};

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
    /// A usage limit: the CLI's message, and when it resets (ms) if the CLI says; never guessed [D74].
    Limited(String, Option<u64>),
    SignIn(String),
    /// The CLI refused to resume this conversation on this account: only a new one goes on (D90 Q4).
    Unresumable(String),
    /// A question to the user, as D177's PendingQuestion: `{id, title, items: [{text, options:
    /// [{label, description}], recommended, multiSelect}]}`, its id the one the CLI gave it.
    Question(Value),
    /// A request for the user's approval, as D177's PendingApproval: `{id, action, reason,
    /// command, cwd, paths, files, branch, host, input, body, to, grant}`; structure only [D65].
    /// Optional `tool`: the normalised tool id whose work awaits this approval.
    Approval(Value),
    /// The CLI cancelled or cleared a pending request by its id: its card closes [D159].
    Resolved(String),
    /// Another client, or the CLI's own rule, answered a pending request by its id: allowed or not.
    Decided(String, bool),
    /// A file the CLI wrote outside the session folder for this session alone, by exact path:
    /// recorded so delete removes it [D35].
    External(String),
    /// The CLI's reply to a request Brigadier sent it, by that request's id: an error, or the
    /// permission level it now runs at when the reply says one.
    Reply {
        id: String,
        error: Option<String>,
        level: Option<String>,
    },
    /// The permission level the CLI says it runs at, which may be safer than the one asked [D175].
    Level(String),
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

/// What a status check found [D45]: where the CLI is, its version, whether it is signed in and
/// how, and the models a session can pick. Never a credential.
#[derive(Default)]
pub struct Check {
    pub version: String,
    pub signed_in: Option<bool>,
    pub how: String,
    pub models: Vec<ModelInfo>,
}

/// A model a session can pick: its id, the name people know it by, whether it runs on this
/// computer, and the effort levels its CLI reports for it, lowest first, with its default; empty
/// and None where the CLI reports none, never guessed [D74, D129].
#[derive(Default)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub local: bool,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
}

impl ModelInfo {
    /// A model known only by its id: no name of its own, no efforts reported.
    pub fn plain(id: &str, local: bool) -> Self {
        let (id, name) = (id.to_string(), id.to_string());
        Self {
            id,
            name,
            local,
            ..Self::default()
        }
    }
}

/// How a CLI keeps more than one account apart [D51]: one home folder per extra account, named by
/// its own variable, so each login stays in its own home and nothing is copied or shared.
pub struct Accounts {
    /// The variable that points the CLI at a home folder.
    pub var: &'static str,
    /// Its default home under HOME, the computer's own login, which Brigadier never touches.
    pub home: &'static str,
    /// Entries of the default home linked into each account's home, so a conversation resumes on
    /// any account: history and instructions, never a credential.
    pub links: &'static [&'static str],
    /// The company whose terms the warning names.
    pub vendor: &'static str,
    /// Its own sign-in and sign-out, as arguments to its binary, run with `var` set.
    pub sign_in: &'static [&'static str],
    pub sign_out: &'static [&'static str],
    /// Sign-in kinds (`Check::how`) the home keeps apart; any other is refused [D51].
    pub kinds: &'static [&'static str],
    pub trust: Option<crate::trust::Trust>,
}

/// What an adapter's CLI can do beyond a message [D109, D129, D170]: steer a running turn, stop
/// one without ending the process, resume a conversation, and its permission levels out of
/// `ask` | `auto` | `full`, most restrictive first. Empty levels: the CLI runs as it always has.
pub struct Can {
    pub steer: bool,
    pub stop: bool,
    pub resume: bool,
    pub levels: &'static [&'static str],
}

/// How a control message reaches the agent: the adapter owns the channel; the host owns the
/// delivery and its record. A server's HTTP channel is its adapter's helper, which reads these.
pub enum Delivery {
    Stdin(String),
}

/// How a running child takes a new model, effort or level before a turn's message.
pub enum Retune {
    /// The message itself carries it.
    InMessage,
    /// Delivered to the child just before the message, in the same input.
    Send(Delivery),
    /// Delivered first on its own; the message follows only once the child replied to each of
    /// these request ids without an error, else the turn is refused [D222].
    Confirm(Delivery, Vec<String>),
    /// The child is started again on the same conversation.
    Restart,
}

/// What a turn runs with, as its input frame records it.
pub fn setup(spec: &Spec) -> Value {
    serde_json::json!({"model": spec.model, "effort": spec.effort, "level": spec.level})
}

pub trait Adapter: Sync {
    fn name(&self) -> &'static str;
    /// The name people know it by.
    fn label(&self) -> &'static str {
        self.name()
    }
    /// Its binary, and the folders under HOME its own installer puts it in.
    fn bin(&self) -> (&'static str, &'static [&'static str]) {
        ("", &[])
    }
    fn exe(&self) -> Option<PathBuf> {
        let (bin, folders) = self.bin();
        setup::find(bin, folders)
    }
    /// The vendor's own install command, a shell line run in a terminal [D45].
    fn install(&self) -> Option<&'static str> {
        None
    }
    /// Its own sign-in, as arguments to its binary run in a terminal, and the button's words.
    fn sign_in(&self) -> Option<(&'static str, &'static [&'static str])> {
        None
    }
    /// Its mark, one SVG drawn on its card only to name it, as the old app had it [D118, D123].
    /// None: a generic terminal is drawn.
    fn mark(&self) -> Option<&'static str> {
        None
    }
    /// Whether its sign-in prints a page that shows a code to paste back, for when the browser
    /// can't hand the sign-in back: the first `https` link it prints.
    fn code_page(&self) -> bool {
        false
    }
    /// A code pasted from that page, as its sign-in takes it, or why it isn't one.
    fn sign_in_code(&self, code: &str) -> Result<String, String> {
        Ok(code.trim().into())
    }
    /// Credential variables it reads, passed on from the login shell, never stored or logged.
    fn keys(&self) -> &'static [&'static str] {
        &[]
    }
    /// Its own status commands, run in `cwd` in the environment its sessions get; every probe
    /// is bounded, on the account `spec` names. Never reads a credential.
    fn check(&self, _spec: &Spec, _exe: &Path, _cwd: &Path) -> Result<Check, String> {
        Err("This CLI has no status check.".into())
    }
    /// How it keeps accounts apart; None: one login only (proposed for OpenCode, D90).
    fn accounts(&self) -> Option<Accounts> {
        None
    }
    /// Folders it worked in, from its own history, newest first.
    fn projects(&self) -> Vec<PathBuf> {
        vec![]
    }
    /// True when each turn is its own process; false when one child reads every message.
    fn per_turn(&self) -> bool;
    /// True when a written input isn't applied until the agent's own reply names its command id
    /// (`Event::Reply`, from `spec.cid`); false when writing it is delivery [D222].
    fn acks(&self) -> bool {
        false
    }
    /// True when a message sent while a turn runs waits in the agent for the next turn; false
    /// refuses it until then (a steer still joins the turn).
    fn queues(&self) -> bool {
        true
    }
    /// A process the agent's launch runs through Brigadier's own binary (`brigadier helper <name>
    /// …`): for a CLI reached over a server, it holds the server and speaks lines on stdin/stdout.
    fn helper(&self, _args: &[String]) -> Result<(), String> {
        Err("This agent has no helper.".into())
    }
    fn launch(&self, spec: &Spec, resume: Option<&str>, text: Option<&str>) -> Launch;
    /// Bytes for a message to a child that is already running.
    fn encode(&self, spec: &Spec, text: &str) -> String;
    fn parse(&self, line: &str) -> Vec<Event>;
    fn can(&self) -> Can {
        Can {
            steer: false,
            stop: false,
            resume: true,
            levels: &[],
        }
    }
    /// How an idle child running at `last` takes `next` before the next message.
    fn retune(&self, _last: &Spec, _next: &Spec) -> Retune {
        Retune::Restart
    }
    /// A control message for the running agent [D159]: `{kind: "answer", request, decision,
    /// reason, answers, reply}` (the request as pending; `reply` is a plain message that answers a
    /// question), `{kind: "steer", text}` or `{kind: "interrupt"}`.
    fn control(&self, _spec: &Spec, _msg: &Value) -> Result<Delivery, String> {
        Err("This agent takes no control messages yet.".into())
    }
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
    /// Removes what `external` can't name, through the backend's own tool. An error keeps the
    /// session folder, and with it the ids a later delete needs to try again [D35].
    fn forget(&self, _spec: &Spec, _resume: &str) -> Result<(), String> {
        Ok(())
    }
    /// Whether the backend's own record names input `cid`, by id: proof it took it. False proves
    /// nothing: the backend may not have written it down yet.
    fn accepted(&self, _spec: &Spec, _resume: &str, _cid: &str) -> bool {
        false
    }
    /// Assistant texts and tool calls counted from the backend's own transcript.
    fn transcript(&self, _spec: &Spec, _resume: &str) -> Option<(u64, u64)> {
        None
    }
    /// Thread `resume`'s turn `turn` (from 0) from the backend's own record: each file edit in
    /// order, as (path, unified diff) per file. None when there's no such record or turn.
    fn diffs(&self, _resume: &str, _turn: u64) -> Option<Vec<Vec<(String, String)>>> {
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

/// The environment every child starts from, the same for a session, a status check and a sign-in:
/// the basics, the login shell's PATH after the CLI's own folder, and the variables `keys` names.
pub fn base_env(spec: &Spec, exe: &Path, keys: &[&str]) -> Vec<(String, String)> {
    let var = |k: &str| std::env::var(k).unwrap_or_default();
    let dir = exe
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let login = setup::login();
    let mut env = vec![
        ("HOME".into(), var("HOME")),
        ("USER".into(), var("USER")),
        ("LANG".into(), "en_US.UTF-8".into()),
        ("TMPDIR".into(), var("TMPDIR")),
        ("PATH".into(), format!("{dir}:{}", login.path)),
    ];
    env.extend(
        keys.iter()
            .filter_map(|k| Some((k.to_string(), login.vars.get(*k)?.clone()))),
    );
    if let Some((var, home)) = &spec.account {
        env.push((var.clone(), home.display().to_string()));
    }
    if spec.mode == "pty" {
        env.push(("TERM".into(), "xterm-256color".into()));
    }
    env
}

/// One bounded status probe of a CLI, in the environment its sessions get.
pub fn probe(
    exe: &Path,
    cwd: &Path,
    keys: &[&str],
    args: &[&str],
    secs: u64,
) -> Result<std::process::Output, String> {
    probe_as(&Spec::default(), exe, cwd, keys, args, secs)
}

/// `probe` on an account: `spec.account` sets its home.
pub fn probe_as(
    spec: &Spec,
    exe: &Path,
    cwd: &Path,
    keys: &[&str],
    args: &[&str],
    secs: u64,
) -> Result<std::process::Output, String> {
    let mut command = std::process::Command::new(exe);
    command
        .args(args)
        .env_clear()
        .envs(base_env(spec, exe, keys))
        .current_dir(cwd);
    setup::run(&mut command, secs)
}

/// The first line of its `--version`.
pub fn version(exe: &Path, cwd: &Path) -> Result<String, String> {
    let out = probe(exe, cwd, &[], &["--version"], 10)?;
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text.lines().next().unwrap_or("").trim().into())
}

/// A one-question PendingQuestion (D177) from a CLI that asks one at a time.
pub fn question(id: &str, text: &str, options: &[String]) -> Event {
    let options: Vec<Value> = options
        .iter()
        .map(|o| serde_json::json!({"label": o}))
        .collect();
    Event::Question(serde_json::json!({"id": id, "title": null, "items": [
        {"text": text, "options": options, "recommended": null, "multiSelect": false}]}))
}

pub fn home_path(rest: &str) -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(rest)
}

/// `rest` in the CLI's home for this spec: the account's home when it runs on one, else `default`
/// under HOME.
pub fn cli_home(spec: &Spec, default: &str, rest: &str) -> PathBuf {
    match &spec.account {
        Some((_, home)) => home.join(rest),
        None => home_path(default).join(rest),
    }
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
        Some(Event::Limited(message.to_string(), None))
    } else if auth.iter().any(|k| m.contains(k)) {
        Some(Event::SignIn(message.to_string()))
    } else {
        None
    }
}
