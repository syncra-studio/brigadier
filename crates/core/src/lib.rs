//! Provider-neutral session model: Session (a folder), Backend (an adapter), Turn and Item.
//! Everything here is shared by both owner designs; only how the owner is reached differs.

mod account;
pub mod adapters;
pub mod fold;
pub mod git;
pub mod norm;
pub mod projects;
pub mod repos;
pub mod rewind;
mod send;
pub mod session;
pub mod switch;
pub mod thread;
pub mod trust;
mod worktree_setup;
pub mod worktrees;

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
pub use send::{Call, Running, applied, level, recover, send};

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
    /// The entry in its CLI's record to resume at, after a rewind that cut there [D384].
    #[serde(skip)]
    pub resume_at: Option<String>,
}

pub fn data_dir() -> PathBuf {
    std::env::var_os("BRIGADIER_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| adapters::home_path("Library/Application Support/Brigadier"))
}

/// A session id names one folder under `sessions/`, so it may hold only plain name characters:
/// no separators, no `..`, nothing absolute.
pub fn check_id(id: &str) -> io::Result<()> {
    let plain = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    if id.is_empty() || id.len() > 128 || !id.chars().all(plain) {
        return Err(io::Error::other(format!("invalid session id {id:?}")));
    }
    Ok(())
}

/// A setup run (an install or sign-in in a terminal [D45]) is a session folder of its own under
/// `setup/`, off the session list, so the host, log and terminal serve it unchanged [D45, D60].
pub const SETUP: &str = "setup-";

pub fn session_dir(data: &Path, id: &str) -> PathBuf {
    match id.strip_prefix(SETUP) {
        Some(agent) => data.join("setup").join(agent),
        None => data.join("sessions").join(id),
    }
}

pub fn ids(data: &Path) -> Vec<String> {
    let mut ids: Vec<String> = fs::read_dir(data.join("sessions"))
        .into_iter()
        .flatten()
        .flatten()
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

const CHECKPOINT_EVERY: u64 = 16 << 20;

/// Folds the whole log, starting from the checkpoint when one is valid, and writes a new one when
/// the log grew a lot. The checkpoint is only a cache: deleting it changes nothing but speed.
pub fn fold(dir: &Path, use_checkpoint: bool) -> io::Result<Folded> {
    let ckpt = dir.join("fold.json");
    let log_len = fs::metadata(dir.join("log")).map(|m| m.len()).unwrap_or(0);
    let f = use_checkpoint
        .then(|| {
            fs::read(&ckpt)
                .ok()
                .and_then(|b| serde_json::from_slice::<Folded>(&b).ok())
        })
        .flatten()
        .filter(|f| f.v == norm::VERSION && f.pos <= log_len)
        .unwrap_or_default();
    let start = f.pos;
    let f = fold_from(dir, f, |_| {})?;
    // Only a fold that ended clean has its state and offset at the same frame.
    if use_checkpoint && f.norm.clean() && f.pos - start >= CHECKPOINT_EVERY {
        let _ = write_atomic(&ckpt, &serde_json::to_vec(&f)?);
    }
    Ok(f)
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
    let log_len = fs::metadata(dir.join("log")).map(|m| m.len()).unwrap_or(0);
    if log_len > f.pos {
        let mut reader = Reader::open(&dir.join("log"), f.pos, f.seq)?;
        let mut items = vec![];
        while let Some(frame) = reader.frame()? {
            f.norm.push(&frame, &mut items);
            for item in items.drain(..) {
                each(&item);
                f.fold.push(&item);
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

/// Kills what is left of process groups this session recorded, checked by start time. Only for
/// when no owner holds them any more.
pub fn sweep(f: &Fold) -> usize {
    fold::live_groups(f, &procs::all())
        .iter()
        .map(|&(g, s)| procs::signal_group(g, s, libc::SIGKILL))
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
