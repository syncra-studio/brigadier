//! Overnight: the user hands the job over and goes. One file in the session's folder keeps all of
//! it, written whole under its lock, so a crash, an update or a restart finds it as it was: what
//! was agreed before Start night, what was decided and proven since, the level to give back, and
//! what its thread still has to be told.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::OpenOptions;
use std::path::Path;
use std::{fs, io};

const FILE: &str = "overnight.json";

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct Overnight {
    /// `asking` (on: its agent asks all it needs), `ready` (it waits for Start night), `night`;
    /// empty is off.
    pub state: String,
    /// The app's op id of the last act on it, which the row carries back to settle it [D30].
    pub op: Option<String>,
    /// When it was turned on, and when its night began (ms).
    pub on: u64,
    pub since: u64,
    /// Its agent was told to ask, in a turn that ran or by the user's own next message.
    pub told: bool,
    /// What it does alone, and what it may do on the way, as its agent said them to the user.
    pub words: String,
    pub may: Vec<String>,
    /// The done list, fixed at Start night.
    pub items: Vec<Item>,
    pub decided: Vec<Decision>,
    /// The level the night took over, till it is given back or the user picks one by hand.
    pub before: Option<Before>,
    /// Full access is still to begin: a night that started and was cut short there takes it next.
    pub full: bool,
    /// The commit its branch was at when the night began.
    pub head: Option<String>,
    /// The agent's own words for the morning: the night ends as its turn does.
    pub report: Option<Report>,
    /// The user ended it: its agent and workers still to be stopped.
    pub stop: bool,
    /// What its thread isn't told yet.
    pub notes: Vec<Value>,
    pub tries: Tries,
    /// The last night's end, and the one notice of its morning.
    pub morning: Option<Morning>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct Item {
    pub title: String,
    pub proof: Option<Proof>,
    pub left: Option<Left>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Proof {
    pub by: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Left {
    pub why: String,
    pub next: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Decision {
    pub title: String,
    pub why: String,
    pub other: String,
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub struct Before {
    pub level: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct Report {
    pub summary: String,
    pub facts: Vec<String>,
    pub url: Option<String>,
}

/// How Brigadier's carrying on goes: messages sent, how many in a row with nothing new (`mark`)
/// and since a part last closed, and failures in a row.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct Tries {
    pub sent: u64,
    pub same: u64,
    pub open: u64,
    pub failed: u32,
    pub mark: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Morning {
    pub since: u64,
    pub at: u64,
    /// None: the user ended it, so nothing tells them.
    pub summary: Option<String>,
}

impl Overnight {
    pub fn on(&self) -> bool {
        !self.state.is_empty()
    }
    pub fn night(&self) -> bool {
        self.state == "night"
    }
    pub fn done(&self) -> usize {
        self.items.iter().filter(|i| i.proof.is_some()).count()
    }
    /// The parts neither proven nor left, as "n. title".
    pub fn open(&self) -> Vec<String> {
        (self.items.iter().enumerate())
            .filter(|(_, i)| i.proof.is_none() && i.left.is_none())
            .map(|(at, i)| format!("{}. {}", at + 1, i.title))
            .collect()
    }
    /// Whether something of it is still to be done: a level, a stop, a word in its thread.
    pub fn due(&self) -> bool {
        self.stop
            || !self.notes.is_empty()
            || (self.before.is_some() && (self.full || !self.night()))
    }

    pub fn row(&self) -> Value {
        if !self.on() {
            return Value::Null;
        }
        let mut words = self.words.clone();
        if !self.may.is_empty() {
            words += &format!(" On the way it may: {}.", self.may.join("; "));
        }
        json!({"state": self.state, "since": self.night().then_some(self.since), "done": self.done(),
            "total": self.items.len(), "decided": self.decided.len(), "words": words.trim()})
    }

    /// What each message of its user's or Brigadier's starts with, for its agent only.
    pub fn lead(&self) -> Option<String> {
        Some(match self.state.as_str() {
            "asking" => "[Overnight is on: the user goes soon and this job is yours till they're back. Run `brigadier help overnight` and follow it: ask everything still open with your question tool, in one round, then run `brigadier overnight ready`. The night hasn't started: only the user starts it.]".into(),
            "ready" => "[Overnight: your done list is in and the user has yet to press Start night. If they change the job, run `brigadier overnight ready` again with the whole list; `brigadier help overnight` is how. The night hasn't started: only the user starts it.]".into(),
            "night" => {
                let may = match self.may.is_empty() {
                    true => "nothing outside your worktree".into(),
                    false => self.may.join("; "),
                };
                let left = match self.items.len() {
                    0 => "No done list yet: run `brigadier overnight ready` once, first.".into(),
                    all => format!("{} of {all} parts left.", self.open().len()),
                };
                format!("[Overnight: the user is away, so you're alone. Never ask: decide by research and log it with `brigadier overnight decided`. You may do alone on the way: {may}. {left} `brigadier help overnight` is how.]")
            }
            _ => return None,
        })
    }
}

/// A session's Overnight, off where it has none.
pub fn load(dir: &Path) -> Overnight {
    (fs::read(dir.join(FILE)).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Changes it under its lock; a refused change writes nothing.
pub fn change<T>(dir: &Path, f: impl FnOnce(&mut Overnight) -> io::Result<T>) -> io::Result<T> {
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("overnight.lock"))?;
    lock.lock()?;
    let mut o = match fs::read(dir.join(FILE)) {
        Ok(b) => serde_json::from_slice(&b)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => Overnight::default(),
        Err(e) => return Err(e),
    };
    let out = f(&mut o)?;
    crate::write_atomic(&dir.join(FILE), &serde_json::to_vec_pretty(&o)?)?;
    Ok(out)
}

/// Whether any session is in its night: a daemon taking over holds the Mac awake from its start.
pub fn any_night(data: &Path) -> bool {
    crate::ids(data)
        .iter()
        .any(|id| load(&crate::session_dir(data, id)).night())
}

/// Its line for a turn that starts now, its agent told by it.
pub(crate) fn led(dir: &Path) -> Option<String> {
    let o = load(dir);
    let lead = o.lead()?;
    if !o.told
        && let Err(e) = change(dir, |o| {
            o.told = true;
            Ok(())
        })
    {
        eprintln!("overnight: {}: {e}", dir.display());
    }
    Some(lead)
}

/// The session's own level, a night's Full access aside: what a fork or a session it starts takes.
pub fn own_level(dir: &Path, level: &Option<String>) -> Option<String> {
    load(dir).before.map_or(level.clone(), |b| b.level)
}
