//! One small adapter per backend. Nothing outside this folder names a provider.

mod classify;
pub mod claude;
mod codex;
mod event;
mod fake;
mod files;
mod model;
mod opencode;
pub mod overhead;
mod rewind;
pub mod setup;
mod shell;

pub use classify::{classify, temporary};
pub use event::{Done, Event, Tool};
pub use files::repeat;
pub use files::{
    change, counts, denied, drop_lines, encode, question, sha1, stopped, under, uuid, uuid_of,
};
pub use model::{Check, Limit, ModelInfo, Subagents, Who, family, iso_ms, mark_superseded};
pub use rewind::{Cut, Failed, Fork, Forked, Landing, Rewound};
pub use setup::{base_env, cli_home, memory, probe, probe_as, version};
pub use shell::{relay_call, shell_step, unwrap_shell};

use crate::Spec;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub struct Launch {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Long-lived children read later messages from stdin.
    pub keep_stdin: bool,
    /// Bytes written right after spawn: the first message, for children that read stdin.
    pub input: Option<String>,
}

pub struct Timing {
    /// Silence shorter than this still reads as working.
    pub silent_ms: u64,
    /// Silence longer than this, with no tool running, reads as stalled.
    pub stall_ms: u64,
    /// A delivered message with no sign of a turn after this reads as not started.
    pub no_start_ms: u64,
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
    let mut setup = json!({"model": spec.model, "effort": spec.effort, "level": spec.level});
    // Only where on, so a setup without them reads as before; a worker's asks go to its parent
    // [D131]. A plan reviewer's go to the user, as a session's: its author is held on that plan
    // while it lives, so it can't answer them [D395, D355].
    let reviewer = spec.opts.contains_key("plan_review");
    let on = [("fast", spec.fast), ("worker", spec.naked && !reviewer)];
    (on.iter().filter(|k| k.1)).for_each(|(k, _)| setup[*k] = true.into());
    // Its subagents' allowlist, launch-only, so a change restarts an idle child [D376].
    if let Some(models) = &spec.ruled.models {
        setup["allowed"] = models.clone().into();
    }
    crate::agent::with_jobs(spec, setup)
}

pub trait Adapter: Sync {
    fn name(&self) -> &'static str;
    /// The name people know it by.
    fn label(&self) -> &'static str {
        self.name()
    }
    /// The short name a list of agents shows it by, as the old app's model picker did.
    fn short_label(&self) -> &'static str {
        self.label()
    }
    /// Its binary, and the folders under HOME its own installer puts it in.
    fn bin(&self) -> (&'static str, &'static [&'static str]) {
        ("", &[])
    }
    /// The CLI the user chose in Settings › Providers first, else the one found [D2082].
    fn exe(&self) -> Option<PathBuf> {
        let (bin, folders) = self.bin();
        setup::chosen(self.name()).or_else(|| setup::find(bin, folders))
    }
    /// The vendor's own install command, a shell line run in a terminal [D45].
    fn install(&self) -> Option<&'static str> {
        None
    }
    /// Its own updater, as arguments to its binary; None: `install` runs again [D2082]. `exe`: the CLI
    /// it will run, which it may ask its version; None: the words shown, never probed [D272].
    fn update(&self, _exe: Option<&Path>) -> Option<&'static [&'static str]> {
        None
    }
    /// The newest version its own updater would install, looked up now; None where that can't be
    /// known (offline, its updates turned off), so no update is offered.
    fn latest(&self) -> Option<String> {
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
    /// Whether its sign-in asks in its own prompt (a picker, a key), so its output is shown open.
    fn sign_in_prompts(&self) -> bool {
        false
    }
    /// The one-time code its sign-in printed for the user to enter on its page, the first `https`
    /// link it prints (a device code: nothing is pasted back), found in what it printed so far.
    fn device_code(&self, _out: &str) -> Option<String> {
        None
    }
    /// Why its sign-in failed, in its own words, found in what it printed.
    fn sign_in_error(&self, _out: &str) -> Option<String> {
        None
    }
    /// A code pasted from that page, as its sign-in takes it, or why it isn't one.
    fn sign_in_code(&self, code: &str) -> Result<String, String> {
        Ok(code.trim().into())
    }
    /// Credential variables it reads, passed on from the login shell, never stored or logged.
    fn keys(&self) -> Vec<String> {
        vec![]
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
    /// The company that made `model` as it runs here, so a review goes to another one; None where
    /// it can't be told [bugfix-1112 D399]. Its accounts' vendor where it has them.
    fn maker(&self, _model: &str) -> Option<&'static str> {
        self.accounts().map(|a| a.vendor)
    }
    /// Folders it worked in, from its own history, newest first.
    fn projects(&self) -> Vec<PathBuf> {
        vec![]
    }
    /// True when each turn is its own process; false when one child reads every message.
    fn per_turn(&self) -> bool;
    /// Its CLI's own helper processes, by name: never work the agent left running [D105].
    fn helpers(&self) -> &[&str] {
        &[]
    }
    /// True when a written input isn't applied until the agent's own reply names its command id
    /// (`Event::Reply`, from `spec.cid`); false when writing it is delivery [D222].
    fn acks(&self) -> bool {
        false
    }
    /// The same for a control message (a steer, an answer, a stop): some agents reply to only some.
    fn acks_control(&self, _msg: &Value) -> bool {
        self.acks()
    }
    /// How long its reply to an input may take (proposed).
    fn confirm_ms(&self) -> u64 {
        10_000
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
    /// The most an image may be for this agent, beyond the app's ceiling: its bytes and its pixels a side; None where nothing is known [D487, D492].
    fn image_limits(&self) -> (Option<u64>, Option<u32>) {
        (None, None)
    }
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
    /// One of its own commands that runs at once, by the name its list gave it (`instant`), through
    /// the running agent's own channel [D2009, D2011].
    fn command(&self, _spec: &Spec, _name: &str) -> Result<Delivery, String> {
        Err("This agent has no command by that name".into())
    }
    /// The `/` menu before it has listed its own: the old app's builtin commands, and for an agent
    /// whose list names no files, what its folders hold [D2098]. `run`: a session's spec as it runs
    /// now; None on Home's draft, whose trusted project is at `cwd`.
    fn fixed_commands(&self, _cwd: Option<&Path>, _run: Option<&Spec>) -> Vec<Value> {
        vec![]
    }
    /// The user's own MCP servers its config holds for `folder`, read only, for the relay: each
    /// `{name, command, args, env, cwd}` or `{name, url, headers}` [D100].
    fn mcp_servers(&self, _folder: &Path) -> Vec<Value> {
        vec![]
    }
    /// Every server of its own config its launch of `spec` may start, those only its CLI runs too:
    /// none of them is work left running [D105, D114].
    fn launched_servers(&self, spec: &Spec) -> Vec<Value> {
        self.mcp_servers(Path::new(&spec.cwd))
    }
    /// Fills in the file of each listed skill or command its list didn't name [D146, D2098].
    fn locate(&self, _run: &Spec, _list: &mut [Value]) {}
    /// Whether its user's own skill of a library skill's name stays, as no flag turns off only
    /// that copy: its sessions skip the library's [D415].
    fn own_skill_wins(&self) -> bool {
        false
    }
    fn timing(&self) -> Timing;
    /// Files and folders this backend wrote outside the session folder for this session only, by
    /// exact path. Delete removes them entirely.
    fn external(&self, _spec: &Spec, _resume: &str) -> Vec<PathBuf> {
        vec![]
    }
    /// Those of them that are throwaway: an archive takes these too.
    fn scratch(&self, _spec: &Spec, _resume: &str) -> Vec<PathBuf> {
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
    /// Whether the backend's own record names input `cid`, by id: proof it took it. False proves nothing: it may not have written it down yet.
    fn accepted(&self, _spec: &Spec, _resume: &str, _cid: &str) -> bool {
        false
    }
    /// Whether its own record proves it never took input `cid`: only a record written before
    /// anything is acted on, whose failure stops the agent, can [D66]. Else nothing is proven.
    fn missed(&self, _spec: &Spec, _resume: &str, _cid: &str) -> bool {
        false
    }
    /// Assistant texts and tool calls counted from the backend's own transcript.
    fn transcript(&self, _spec: &Spec, _resume: &str) -> Option<(u64, u64)> {
        None
    }
    /// Thread `resume`'s turn `turn` (from 0) from the backend's own record: each file edit in order, as (path, unified diff) per file. None when there's no such record or turn.
    fn diffs(&self, _resume: &str, _turn: u64) -> Option<Vec<Vec<(String, String)>>> {
        None
    }
    /// Whether this cut names a place in its record exactly; only those are offered [D384].
    fn can_cut(&self, _cut: &Cut) -> bool {
        false
    }
    /// Cuts the conversation `resume` at `cut`.
    fn rewind(&self, _spec: &Spec, _resume: &str, _cut: &Cut) -> Result<Rewound, Failed> {
        Err(Failed::Refused("This agent can't rewind.".into()))
    }
    /// What the CLI's own record shows of a cut begun at `at` (ms) whose outcome wasn't heard.
    fn landed(&self, _spec: &Spec, _resume: &str, _cut: &Cut, _at: u64) -> Landing {
        Landing::NotApplied
    }
    /// Its native fork; None: every fork begins from the hand-off [D90, D1063].
    fn forking(&self) -> Option<&dyn Fork> {
        None
    }
    /// The cheapest of `models`, its last check's list, for the message writer, by its own reading of them; `current` is
    /// the session's model. None: it can't tell, so the writer uses the session's model at its lowest effort (proposed, D1163) [D1029].
    fn cheap(&self, _current: Option<&str>, _models: &[ModelInfo]) -> Option<String> {
        None
    }
    /// The cheapest of `models` for a review's quick look, a one-shot whose launch with the
    /// `sealed` opt blocks every tool, its CLI's own too. None: it can't, so there is no quick
    /// look and the change gets a full review [beat-competitors D56].
    fn glance(&self, _models: &[ModelInfo]) -> Option<String> {
        None
    }
    /// Its entries in the default jobs, as (job, model id or versionless family, effort), in its
    /// order; routing keeps the ones its list names [D392 P1].
    fn seeds(&self) -> &'static [Seed] {
        &[]
    }
    /// Whether it hands Brigadier a plan to approve, so the Adversarial review reviews its plans.
    fn plans(&self) -> bool {
        false
    }
    /// Whether image work goes to its models first [D337].
    fn draws_first(&self) -> bool {
        false
    }
    /// What its CLI lets the rules make of its own subagents [D376].
    fn subagents(&self) -> Subagents {
        Subagents::Untold
    }
    /// The model a launch of `spec` runs, where it names one when none is picked [D376].
    fn runs(&self, spec: &Spec) -> Option<String> {
        spec.model.clone()
    }
    /// `host:port` of its API, whose reaching it again ends a wait to resume a turn the network cut [D339]; None: it waits its backoff alone.
    fn api_host(&self) -> Option<String> {
        None
    }
}

/// A default job's entry: (job, model id, effort).
pub type Seed = (&'static str, &'static str, Option<&'static str>);

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

pub fn home_path(rest: &str) -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(rest)
}

/// Text of a JSON line's field, or empty.
pub fn s<'a>(v: &'a Value, path: &[&str]) -> &'a str {
    path.iter().fold(v, |v, k| &v[*k]).as_str().unwrap_or("")
}
