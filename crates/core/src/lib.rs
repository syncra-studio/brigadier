//! Provider-neutral session model: Session (a folder), Backend (an adapter), Turn and Item.
//! Everything here is shared by both owner designs; only how the owner is reached differs.

mod account;
pub mod adapters;
pub mod agent;
pub mod archive;
pub mod background;
pub mod feedback;
pub mod fold;
pub mod folder;
pub mod fork;
pub mod git;
pub mod handoff;
pub mod host;
pub mod images;
mod kept;
pub mod library;
pub mod lid;
pub mod message;
pub mod norm;
pub mod overnight;
pub mod projects;
pub mod rebirth;
pub mod repos;
pub mod rewind;
pub mod rules;
mod send;
pub mod session;
pub mod share;
pub mod switch;
pub mod thread;
pub mod title;
pub mod trust;
mod worktree_setup;
pub mod worktrees;
pub mod writer;

use brigadier_frames::log::{self, Reader};
use brigadier_frames::procs;
use fold::Fold;
use norm::Norm;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub use account::{account_home, as_run, data_of};
pub use kept::{fold, keep};
pub use send::{Call, CallIn, Running, applied, level, reconnect, recover, relevel, send};

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Spec {
    pub id: String,
    pub backend: String,
    /// "pty" for a setup or sign-in run; a conversation always launches on pipes [D293, D295].
    pub mode: String,
    pub cwd: String,
    /// The project it was started in [D165]; None before 1a, or when started with only a folder.
    pub project: Option<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub opts: BTreeMap<String, String>,
    pub created: u64,
    /// Its permission level, `ask` | `auto` | `full`; None: the agent's most restrictive. Read
    /// again at each turn start [D129, D170].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    /// The app's op id of the last level picked, which the row carries back to settle it [D30].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level_op: Option<String>,
    /// Its model's reasoning effort; None: the CLI's own default [D129].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// On its model's fast tier, where the model has one; its adapter runs it so.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fast: bool,
    /// The session it was forked from, which its row nests under [D48, D1063].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_of: Option<String>,
    /// The added account it started on, picked with Use; None: the computer's login. Its log's
    /// switches move it from there [D2082].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub starts_on: Option<String>,
    /// A worker's: its CLI loads no skills, MCP servers or memory of its own and doesn't compact;
    /// it reaches them through `brigadier` [D89, D98].
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub naked: bool,
    /// A Brigade: each message of its user points its agent at `brigadier help brigade` [D185].
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub brigade: bool,
    /// A Brigade's sub-session: a full lead whose asks and result go to this boss [D189].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boss: Option<String>,
    #[serde(skip)]
    pub dir: PathBuf,
    /// The account it runs on now, as (the CLI's home variable, that home), from its log; None is
    /// the computer's own login [D51].
    #[serde(skip)]
    pub account: Option<(String, PathBuf)>,
    /// The session's grants from its log, for a child started anew [D193].
    #[serde(skip)]
    pub grants: Vec<Value>,
    /// The command id of the input being built, for an agent whose reply names it [D222].
    #[serde(skip)]
    pub cid: Option<String>,
    /// The images the input being built carries, each in its session's `attachments/`, sent in
    /// the agent's own form [D2008].
    #[serde(skip)]
    pub images: Vec<PathBuf>,
    /// The agent's own commands its chips name, as the agent listed them, sent in its own form
    /// where it has one [D164, D2009].
    #[serde(skip)]
    pub commands: Vec<Value>,
    /// The entry in its CLI's record to resume at, after a rewind that cut there [D384].
    #[serde(skip)]
    pub resume_at: Option<String>,
    /// Its launch forks the conversation it resumes into a new one: a fork's first, where the
    /// agent's CLI makes the fork [D1089].
    #[serde(skip)]
    pub branch: bool,
    /// The user's jobs in words, set at launch for a session's lead text, never kept [D387].
    #[serde(skip)]
    pub jobs: Option<String>,
    /// Settings › Routing's one check, set by the CLI, which every launch runs on what it starts [D376].
    #[serde(skip)]
    pub rules: Option<Check>,
    /// What that check made of this launch, for its CLI's own subagents [D376].
    #[serde(skip)]
    pub ruled: Ruled,
    /// Settings › Routing's Adversarial review, as it is when a turn starts: its plans wait on a
    /// review [D385, §6]. Never kept.
    #[serde(skip)]
    pub review: bool,
}

/// The check: `agent`'s `model` (None: its default) at `effort` (None: the model's default), run in
/// the folder `cwd`; the rule's words refusing it, else what the rules make of it.
pub type Check = fn(&Path, &str, &str, Option<&str>, Option<&str>) -> Result<Ruled, String>;

/// What the rules make of one launch [D376].
#[derive(Clone, Default)]
pub struct Ruled {
    /// The effort a rule's cap runs it at, where the one asked is above it [D338].
    pub effort: Option<String>,
    /// A rule names its agent, so its CLI's own subagents start on its model and effort.
    pub touched: bool,
    /// The models its agent lists that no rule bars, where a rule bars one.
    pub models: Option<Vec<String>>,
}

impl Spec {
    /// The check run on starting this on `agent`; why not, else this at the capped effort and with
    /// what its subagents keep. No check set: as it is.
    pub fn ruled(&self, agent: &str) -> Result<Spec, String> {
        let Some(check) = self.rules else {
            return Ok(self.clone());
        };
        let model = adapters::get(agent).map_or(self.model.clone(), |a| a.runs(self));
        let ruled = check(
            &data_of(self),
            &self.cwd,
            agent,
            model.as_deref(),
            self.effort.as_deref(),
        )?;
        Ok(Spec {
            effort: ruled.effort.clone().or(self.effort.clone()),
            ruled,
            ..self.clone()
        })
    }
}

pub fn data_dir() -> PathBuf {
    std::env::var_os("BRIGADIER_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(default_data_dir)
}

/// The data folder when BRIGADIER_DATA doesn't name another.
pub fn default_data_dir() -> PathBuf {
    adapters::home_path("Library/Application Support/Brigadier")
}

/// A session id names one folder under `sessions/`, so it may hold only plain name characters:
/// no separators, no `..`, nothing absolute.
pub fn check_id(id: &str) -> io::Result<()> {
    let plain = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    // A leading "-" is a flag mistaken for an id, as `start --help`.
    if id.is_empty() || id.len() > 128 || id.starts_with('-') || !id.chars().all(plain) {
        return Err(io::Error::other(format!("invalid session id {id:?}")));
    }
    Ok(())
}

/// A setup run (an install or sign-in in a terminal [D45]) is a session folder of its own under
/// `setup/`, off the session list, so the host, log and terminal serve it unchanged [D45, D60].
pub const SETUP: &str = "setup-";
/// A terminal, a tab's or a `!` command's, is a folder of its own under `terminals/`, named by its
/// tab's or command's id, which a draft's tab keeps when it becomes a session's [D315]. Whose it
/// is lives with its owner (`cli::terminal`), so a host, log and terminal serve it unchanged.
pub const TERM: &str = "term-";

pub fn session_dir(data: &Path, id: &str) -> PathBuf {
    if let Some(agent) = id.strip_prefix(SETUP) {
        data.join("setup").join(agent)
    } else if let Some(term) = id.strip_prefix(TERM) {
        data.join("terminals").join(term)
    } else {
        data.join("sessions").join(id)
    }
}

pub fn ids(data: &Path) -> Vec<String> {
    let mut ids: Vec<String> = fs::read_dir(data.join("sessions"))
        .into_iter()
        .flatten()
        .flatten()
        // A deleted session's folder kept only for a worktree another uses isn't one [D1080].
        .filter(|e| {
            let p = e.path();
            !p.join(worktrees::RETAINED).exists() || p.join("session.json").exists()
        })
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    ids.sort();
    ids
}

/// How the daemon keeps the Mac awake [D30, D36]: never, while a session works (the default, as in
/// the old app), or always while it runs. Set by `brigadier awake`, kept in the data folder.
pub const AWAKE_MODES: [&str; 3] = ["off", "work", "always"];

pub fn awake_mode(data: &Path) -> &'static str {
    let set = fs::read_to_string(data.join("awake")).unwrap_or_default();
    AWAKE_MODES
        .into_iter()
        .find(|m| *m == set.trim())
        .unwrap_or("work")
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)
}

pub fn create(data: &Path, spec: &Spec) -> io::Result<Spec> {
    check_id(&spec.id)?;
    let dir = session_dir(data, &spec.id);
    // A deleted session's folder still holding a worktree another uses keeps its id [D1080].
    if dir.join(worktrees::RETAINED).exists() {
        return Err(io::Error::other(
            "That id still holds a folder another session uses.",
        ));
    }
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)?;
    fs::set_permissions(data, fs::Permissions::from_mode(0o700))?;
    write_atomic(
        &dir.join("session.json"),
        serde_json::to_string_pretty(spec)?.as_bytes(),
    )?;
    load(data, &spec.id)
}

pub fn load(data: &Path, id: &str) -> io::Result<Spec> {
    let dir = session_dir(data, id);
    let mut spec: Spec = serde_json::from_slice(&fs::read(dir.join("session.json"))?)?;
    spec.dir = dir;
    Ok(spec)
}

/// A fold with the reader position it reached.
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Folded {
    pub v: u32,
    pub pos: u64,
    pub seq: u64,
    pub fold: Fold,
    pub norm: Norm,
}

/// The account a session starts on, read again till its first input: a hold's answer may move a
/// worker's after its log has notes. Only a change is taken, so a fork's own stays.
fn starts_on(dir: &Path, f: &mut Fold) {
    let spec = fs::read(dir.join("session.json")).ok();
    let spec = spec.and_then(|b| serde_json::from_slice::<Spec>(&b).ok());
    let now = spec.and_then(|s| Some((s.backend, s.starts_on?)));
    if now == f.started {
        return;
    }
    if let Some((backend, _)) = &f.started {
        f.accounts.remove(backend);
    }
    f.accounts.extend(now.clone());
    f.started = now;
}

/// Carries a fold on from where `f` stopped, handing each new item to `each`. `pos` moves only at
/// frames where the normaliser is clean, so when it ends unclean the fold holds items past `pos`:
/// keep such a result for status, but resume only from a clean one. A fold from another
/// normaliser version starts over.
pub fn fold_from(dir: &Path, mut f: Folded, mut each: impl FnMut(&Value)) -> io::Result<Folded> {
    if f.v != norm::VERSION {
        f = Folded {
            v: norm::VERSION,
            ..Default::default()
        };
    }
    if f.fold.cids.is_empty() {
        starts_on(dir, &mut f.fold);
    }
    let log_len = fs::metadata(dir.join("log")).map(|m| m.len()).unwrap_or(0);
    if log_len > f.pos {
        let mut reader = Reader::open(&dir.join("log"), f.pos, f.seq)?;
        let (mut items, mut replan, mut seq) = (vec![], false, 0);
        while let Some(frame) = reader.frame()? {
            seq = frame.seq;
            f.norm.push(&frame, &mut items);
            for item in items.drain(..) {
                each(&item);
                f.fold.push(&item);
                replan |= item["kind"] == "note"
                    && matches!(item["event"].as_str(), Some("rewound" | "forked"));
            }
            // Any output is a sign of life, even bytes that make no item (heartbeats).
            if matches!(frame.kind, log::OUT | log::ERR) {
                f.fold.last_out = frame.ts;
            }
            if f.norm.clean() {
                f.pos = reader.pos;
                f.seq = reader.seq;
            }
        }
        if replan {
            f.fold.plan = fold::todo::Todo::replay(dir, seq)?;
        }
    }
    Ok(f)
}

/// Every item from the start, in order. Returns an FNV-1a hash over them, so two reads can be
/// compared exactly.
pub fn read(dir: &Path, mut each: impl FnMut(&Value)) -> io::Result<u64> {
    let mut hash: u64 = 0xcbf29ce484222325;
    let mut norm = Norm::default();
    let mut reader = Reader::open(&dir.join("log"), 0, 0)?;
    let mut items = vec![];
    while let Some(frame) = reader.frame()? {
        norm.push(&frame, &mut items);
        for item in items.drain(..) {
            for b in item.to_string().bytes().chain(*b"\n") {
                hash = (hash ^ b as u64).wrapping_mul(0x100000001b3);
            }
            each(&item);
        }
    }
    Ok(hash)
}

/// Roughly the last `n` items, read from the end only: what a long thread shows when opened.
pub fn tail(dir: &Path, spec: &Spec, n: usize) -> io::Result<Vec<Value>> {
    let path = dir.join("log");
    let len = fs::metadata(&path)?.len();
    let mut window = 256u64 << 10;
    loop {
        let mut reader = Reader::open(&path, 0, 0)?;
        reader.sync_to(len.saturating_sub(window))?;
        let mut norm = Norm::default();
        norm.backend = spec.backend.clone();
        let (mut items, mut out) = (vec![], vec![]);
        while let Some(frame) = reader.frame()? {
            norm.push(&frame, &mut items);
            out.append(&mut items);
        }
        if out.len() >= n || window >= len {
            let skip = out.len().saturating_sub(n);
            return Ok(out.split_off(skip));
        }
        window *= 4;
    }
}

/// Kills what is left of process groups this session recorded, checked by start time; what runs
/// outside them goes on. Only for when no owner holds them any more. Only groups recorded under
/// `dir` itself: a copied log names another folder's, maybe live, and an old record names none [D220].
pub fn sweep(f: &Fold, dir: &Path) -> usize {
    let here = fs::canonicalize(dir).unwrap_or_else(|_| dir.into());
    fold::live_groups(f, &procs::all())
        .iter()
        .filter(|g| here.to_str() == Some(g.2.as_str()))
        .map(|&&(g, s, _)| procs::signal_group(g, s, libc::SIGKILL))
        .sum()
}

/// The backend's CLI version, cached by executable path and modification time.
pub fn cli_version(spec: &Spec, a: &dyn adapters::Adapter) -> String {
    let Some(exe) = a.exe() else {
        return String::new();
    };
    let mtime = fs::metadata(&exe)
        .and_then(|m| m.modified())
        .map(|t| format!("{t:?}"))
        .unwrap_or_default();
    let cache = spec
        .dir
        .parent()
        .and_then(Path::parent)
        .map(|d| d.join("versions.json"))
        .unwrap_or_default();
    let mut map: BTreeMap<String, (String, String)> = fs::read(&cache)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let key = exe.display().to_string();
    if let Some((m, v)) = map.get(&key)
        && *m == mtime
    {
        return v.clone();
    }
    let out = std::process::Command::new(&exe)
        .arg("--version")
        .env_clear()
        .env("HOME", adapters::home_path(""))
        .output();
    let version = out
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string()
        })
        .unwrap_or_default();
    map.insert(key, (mtime, version.clone()));
    let _ = write_atomic(&cache, &serde_json::to_vec(&map).unwrap_or_default());
    version
}
