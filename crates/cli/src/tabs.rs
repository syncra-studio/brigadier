//! The tabs over a chat or session, one system for both [D360, D361]: which are open, their order
//! and which is in front, kept in the session's folder and gone with it [D35]. Home's live beside
//! its draft. The Chat tab is implied, always first. Every change is safe to send twice, except
//! `reopen`, and answers the whole state with a `rev` that only grows, so the app can tell Rust's
//! newer word from an older one after a lost reply [D30, D71].

use crate::{HOME_DRAFT, USAGE, arg};
use brigadier_core::{self as core, projects, session, worktrees};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

const CHAT: &str = "chat";
/// The old app's New tab chooser, and a terminal, drawn only for now [D361]; a conflicted file and a pull
/// request, each with its target, a path or a PR number; the Review diff [D1014, D1032].
const KINDS: [&str; 5] = ["new", "terminal", "conflict", "pr", "review"];
const TERMINAL: &str = "terminal";
const NEW: &str = "new";
const CLOSED_KEPT: usize = 20;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct Tab {
    id: String,
    kind: String,
    /// The tab it was opened from: where a close goes back to.
    opener: String,
    /// What a conflict or PR tab shows: its file's path, or the PR's number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target: Option<String>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct Closed {
    tab: Tab,
    index: usize,
}

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
struct Tabs {
    rev: u64,
    active: String,
    tabs: Vec<Tab>,
    closed: Vec<Closed>,
}

fn file(data: &Path, id: &str) -> PathBuf {
    if id == HOME_DRAFT {
        data.join("home-tabs.json")
    } else {
        core::session_dir(data, id).join("tabs.json")
    }
}

/// Commands run at once on the daemon's threads: every change holds the session's lifecycle lock,
/// so it can't overwrite another or land on a session being archived or deleted [D35].
fn lock(data: &Path, id: &str) -> io::Result<File> {
    if id == HOME_DRAFT {
        projects::lock(data, "home-tabs.lock")
    } else {
        worktrees::lock(&core::session_dir(data, id))
    }
}

/// None yet, or not readable as tabs: only the Chat tab, which is never lost.
fn read(path: &Path) -> Tabs {
    let mut tabs: Tabs = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    if tabs.active.is_empty() {
        tabs.active = CHAT.into();
    }
    tabs
}

fn write(path: &Path, tabs: &Tabs) -> io::Result<()> {
    core::write_atomic(path, &serde_json::to_vec(tabs)?)
}

fn state(tabs: &Tabs) -> Value {
    json!({"ok": true, "rev": tabs.rev, "active": tabs.active, "tabs": tabs.tabs})
}

impl Tabs {
    fn at(&self, id: &str) -> Option<usize> {
        self.tabs.iter().position(|tab| tab.id == id)
    }

    fn exists(&self, id: &str) -> bool {
        id == CHAT || self.at(id).is_some()
    }

    /// The tab already showing this file or PR, so one never gets two tabs.
    fn same(&self, kind: &str, target: &Option<String>) -> Option<String> {
        target.as_ref()?;
        let tab = self
            .tabs
            .iter()
            .find(|t| t.kind == kind && t.target == *target)?;
        Some(tab.id.clone())
    }

    /// Takes the tab at `at` and remembers it for ⇧⌘T.
    fn remove(&mut self, at: usize) -> Tab {
        let tab = self.tabs.remove(at);
        self.closed.push(Closed {
            tab: tab.clone(),
            index: at,
        });
        let over = self.closed.len().saturating_sub(CLOSED_KEPT);
        self.closed.drain(..over);
        tab
    }

    /// Closes `at`; the tab in front goes to its opener, else its right, else its left.
    fn close(&mut self, at: usize) {
        let tab = self.remove(at);
        if self.active != tab.id {
            return;
        }
        let next = if self.exists(&tab.opener) {
            Some(tab.opener)
        } else {
            self.tabs
                .get(at)
                .or(at.checked_sub(1).and_then(|i| self.tabs.get(i)))
                .map(|t| t.id.clone())
        };
        self.active = next.unwrap_or_else(|| CHAT.into());
    }

    /// Closes every tab after `keep` of them, then shows `id` if the one in front went.
    fn close_from(&mut self, keep: usize, id: &str) {
        for at in (keep..self.tabs.len()).rev() {
            self.remove(at);
        }
        if !self.exists(&self.active) {
            self.active = id.into();
        }
    }
}

/// A conflict and a PR tab need their target, every other kind refuses one. A conflict's is its file,
/// relative and staying in the session's checkout; a PR's is its number, written plainly so one PR
/// is one tab [D1032].
fn check_target(kind: &str, target: Option<&str>) -> io::Result<()> {
    let ok = match (kind, target) {
        // shortcut: a string check, so a symlink in the checkout could lead out; resolve it when 2.23 reads the file.
        ("conflict", Some(path)) => {
            !path.contains('\0')
                && path
                    .split('/')
                    .all(|s| !s.is_empty() && s != "." && s != "..")
        }
        ("pr", Some(number)) => number.parse::<u64>().is_ok_and(|n| n.to_string() == number),
        ("conflict" | "pr", None) => false,
        (_, target) => target.is_none(),
    };
    if ok {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "not a {kind} tab's target: {}",
            target.unwrap_or("none")
        )))
    }
}

/// `tabs <id> [open <tab> <kind> [<target>] | replace <tab> <kind> | select <tab> | close <tab> |
/// close-others <tab> | close-right <tab> | move <tab> <to> | reopen]`, for a session or Home.
pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    let path = file(data, id);
    let Some(op) = args.get(2).map(String::as_str) else {
        return Ok(state(&read(&path)));
    };
    let _one = lock(data, id)?;
    let home = id == HOME_DRAFT;
    if !home {
        core::load(data, id)?;
    }
    // Read under the lock: a terminal can't land on a session that started archiving just now.
    let shut = (!home)
        .then(|| session::closed(&core::session_dir(data, id)))
        .flatten();
    let allowed = |kind: &str| match shut.filter(|_| kind == TERMINAL) {
        Some(why) => Err(io::Error::other(why)),
        None => Ok(()),
    };
    let kind = || {
        let kind = arg(args, 4)?;
        if !KINDS.contains(&kind) {
            return Err(io::Error::other(format!("unknown tab kind {kind}")));
        }
        allowed(kind)?;
        Ok::<_, io::Error>(kind.to_string())
    };
    let was = read(&path);
    let mut now = was.clone();
    match op {
        "reopen" => {
            if let Some(Closed { tab, index }) = now.closed.pop()
                && !now.exists(&tab.id)
                && allowed(&tab.kind).is_ok()
            {
                if let Some(same) = now.same(&tab.kind, &tab.target) {
                    now.active = same;
                } else {
                    now.active = tab.id.clone();
                    let index = index.min(now.tabs.len());
                    now.tabs.insert(index, tab);
                }
            }
        }
        "open" => {
            let (tab, kind) = (arg(args, 3)?, kind()?);
            let target = args.get(5).cloned();
            core::check_id(tab)?;
            check_target(&kind, target.as_deref())?;
            if let Some(same) = now.same(&kind, &target) {
                now.active = same;
            } else {
                if !now.exists(tab) {
                    let index = now.at(&now.active).map_or(0, |at| at + 1);
                    let opener = now.active.clone();
                    let id = tab.to_string();
                    now.tabs.insert(
                        index,
                        Tab {
                            id,
                            kind,
                            opener,
                            target,
                        },
                    );
                }
                now.active = tab.into();
            }
        }
        "replace" => {
            let (tab, kind) = (arg(args, 3)?, kind()?);
            // A New tab becomes what was picked on it: a kind with no target.
            check_target(&kind, None)?;
            if let Some(at) = now.at(tab)
                && now.tabs[at].kind == NEW
            {
                now.tabs[at].kind = kind;
                now.active = tab.into();
            }
        }
        "select" => {
            let tab = arg(args, 3)?;
            if now.exists(tab) {
                now.active = tab.into();
            }
        }
        "close" => {
            if let Some(at) = now.at(arg(args, 3)?) {
                now.close(at);
            }
        }
        "close-others" => {
            let tab = arg(args, 3)?;
            if now.exists(tab) {
                for at in (0..now.tabs.len()).rev() {
                    if now.tabs[at].id != tab {
                        now.remove(at);
                    }
                }
                now.active = tab.into();
            }
        }
        "close-right" => {
            let tab = arg(args, 3)?;
            if now.exists(tab) {
                let keep = now.at(tab).map_or(0, |at| at + 1);
                now.close_from(keep, tab);
            }
        }
        "move" => {
            let tab = arg(args, 3)?;
            let to: usize = arg(args, 4)?.parse().map_err(|_| io::Error::other(USAGE))?;
            if let Some(at) = now.at(tab) {
                let moved = now.tabs.remove(at);
                now.tabs.insert(to.min(now.tabs.len()), moved);
            }
        }
        _ => return Err(io::Error::other(USAGE)),
    }
    if now != was {
        now.rev = was.rev + 1;
        write(&path, &now)?;
    }
    Ok(state(&now))
}

/// A session made from Home takes Home's tabs, in order, with the one in front, as the old app's
/// did. The session's file is written first: a crash between the two leaves tabs in both places
/// rather than in neither.
pub fn carry(data: &Path, to: &str) -> io::Result<()> {
    let _home = lock(data, HOME_DRAFT)?;
    let _one = lock(data, to)?;
    let from = file(data, HOME_DRAFT);
    let mut home = read(&from);
    if home.tabs.is_empty() {
        return Ok(());
    }
    let carried = Tabs {
        rev: 1,
        active: home.active.clone(),
        tabs: std::mem::take(&mut home.tabs),
        closed: vec![],
    };
    write(&file(data, to), &carried)?;
    home.active = CHAT.into();
    home.rev += 1;
    write(&from, &home)
}
