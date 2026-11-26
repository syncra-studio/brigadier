//! What a backend's stream reads as: its events, and the tool calls they start and end.

use super::Limit;
use serde_json::Value;

#[derive(Debug, PartialEq)]
pub enum Event {
    TurnStart,
    TurnEnd(bool),
    Text(String),
    /// A piece of the reply as the agent writes it; its whole text follows as `Text` [D147].
    TextDelta(String),
    Reasoning(String),
    ToolStart(Tool),
    ToolEnd(Done),
    /// All its CLI runs in the background, by id (each one's end wakes the agent), then the
    /// subagents among it whose own work still runs: a run of theirs that ends now isn't their end.
    Awaiting(Vec<String>, Vec<String>),
    /// A command or watch its CLI runs in the background, by the id it gave it, and what the agent
    /// said it does, else its command: its Background row's words [D187].
    Background(String, String),
    Resume(String),
    /// A usage limit: the CLI's message, and when it resets (ms) if the CLI says; never guessed [D74].
    Limited(String, Option<u64>),
    /// The account has no credits left: no limit, it never comes back by itself.
    OutOfCredits,
    /// Its usage limits as its CLI reported them during a run, each window it named [D28, D2039].
    Limits(Vec<Limit>),
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
    /// A tool call's folder, by its id, where its CLI says it only beside its ask, which carries it [D391].
    Cwd(String, String),
    /// The CLI cancelled or cleared a pending request by its id: its card closes [D159].
    Resolved(String),
    /// Another client, or the CLI's own rule, answered a pending request by its id: allowed or not.
    Decided(String, bool),
    /// A file the CLI wrote outside the session folder for this session alone, removed on delete [D35].
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
    /// The CLI tries a request again by itself: which try, of how many, and when the next goes (ms),
    /// each where it says [D487].
    Retrying {
        attempt: Option<u64>,
        max: Option<u64>,
        at: Option<u64>,
    },
    /// The CLI ran this request on another model than the one asked: from (where it says), to [D487].
    Rerouted(Option<String>, String),
    /// The model the CLI says this conversation runs on, by its own id (`claude-opus-5-5` behind
    /// `opus`): a worker's `ran.real` [D383].
    Model(String),
    /// A failed turn's error, with its cause where the CLI says it as structure [D487]: "capacity",
    /// "model" (not available), "blocked" (a reply withheld), "ended" (the conversation can't go
    /// on), "review" (its own reviewer ended the turn), "timeout", "connection"; "" for any other.
    Failed(&'static str, String),
    /// The CLI holds its reply for extra safety checks (true), or let it go (false) [D487].
    Checking(bool),
    /// An image made, `{id, progress, attachment, name, prompt, error}`, kept in the session [D289].
    Image(Value),
    /// An action the CLI's own rule or reviewer turned down, with nobody asked [D487].
    Denied,
    /// An action its CLI's own safety check gave no verdict on: not run, nobody asked [D455].
    Unchecked,
    Usage(Value),
    /// Tokens in the window now, its size where told, and if a model message opens [D88, D486].
    Context(u64, Option<u64>, bool),
    /// The agent's to-do list as it last wrote it: `[{text, status}]` [D104].
    Plan(Vec<Value>),
    /// The agent's own commands, as its protocol lists them, replacing any listed before: each
    /// `{name, description, kind: "command"|"skill"|"prompt" (an MCP server's), path, instant}`,
    /// `path` its file where the agent says or keeps one, `instant` if it runs at once [D164, D2009].
    Commands(Vec<Value>),
    /// Where this turn sits in the CLI's own record, for a later cut: its first entry and its
    /// latest, as far as this line says.
    Mark {
        start: Option<String>,
        end: Option<String>,
    },
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
    /// The MCP server an MCP tool comes from, as configured (`atlassian`): its calls count together [D176].
    pub server: Option<String>,
    /// What the agent said a command does, its row's words when given [D214].
    pub description: String,
    /// A shell command's line as it reads, whatever its step: opened steps show it [D95, D116].
    pub command: String,
}

/// A tool call as it ends; `cut`: a command sent to the background or interrupted [D74].
#[derive(Debug, PartialEq, Default)]
pub struct Done {
    pub id: String,
    pub output: String,
    pub ok: bool,
    pub exit: Option<i64>,
    pub cut: bool,
    pub changes: Vec<Value>,
    /// A subagent's own session id, or the id its CLI gave a command it sent to the background.
    pub child: Option<String>,
    pub parent: Option<String>,
    pub at: Option<u64>,
}
