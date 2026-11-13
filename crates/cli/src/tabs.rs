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
/// The old app's New tab chooser, and a terminal, drawn only for now [D361]; a pull request with its
/// number, or `list` for the session's PRs [D205]; the Review diff [D1014, D1032]; an attachment, `<id>/<its name>`, as the old app opened a
/// pasted text or a text file in a tab, and now every file that isn't an image [D2098, D2104]; the
/// card's Background history [D200].
const KINDS: [&str; 6] = [
    "new",
    "terminal",
    "pr",
    "review",
    "attachment",
    "background",
];
const TERMINAL: &str = "terminal";
const NEW: &str = "new";
/// A checkout file, opened by `file` only, as it needs a line and a preview too [D1002, D1032].
const FILE: &str = "file";
const CLOSED_KEPT: usize = 20;
/// Kinds a session has one of: opening one again brings it to the front, on its new target [D478, D1114].
const ONE: [&str; 2] = ["review", "background"];

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
struct Tab {
    id: String,
    kind: String,
    /// The tab it was opened from: where a close goes back to.
    opener: String,
    /// What a file or PR tab shows: its file's path, or the PR's number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    /// A file tab's line last asked for, and whether it's the preview the next file opened takes
    /// the place of, as in the old app [D1002].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    line: Option<u32>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    preview: bool,
    /// A Review tab's scope last picked, so it comes back after a restart [D1187].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scope: Option<String>,
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
    // A saved tab of a kind this build no longer draws would crash the app: it's dropped [D30].
    let known = |t: &Tab| t.kind == FILE || KINDS.contains(&t.kind.as_str());
    tabs.tabs.retain(known);
    tabs.closed.retain(|c| known(&c.tab));
    if !tabs.tabs.iter().any(|t| t.id == tabs.active) {
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

    /// The tab already showing this file or PR, or the session's one tab of its kind, so one never
    /// gets two tabs.
    fn same(&self, kind: &str, target: &Option<String>) -> Option<String> {
        let one = ONE.contains(&kind);
        if !one {
            target.as_ref()?;
        }
        // An attachment is one tab by its id, whichever name it was opened by.
        let key = |t: &Option<String>| match kind {
            "attachment" => t
                .as_deref()
                .and_then(|t| t.split('/').next())
                .map(String::from),
            _ => t.clone(),
        };
        let tab = (self.tabs.iter())
            .find(|t| t.kind == kind && (one || key(&t.target) == key(target)))?;
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

/// A thread row's path may be absolute: a Review tab keeps it relative to the session's checkout [D1038].
fn relative(data: &Path, id: &str, target: String) -> io::Result<String> {
    let path = Path::new(&target);
    if !path.is_absolute() {
        return Ok(target);
    }
    let root = core::git::checkout(data, &core::git::Target::Session(id))?.root;
    // The checkout's root is canonical; a deleted file's folder still resolves.
    let real = (path.parent().and_then(|dir| fs::canonicalize(dir).ok()))
        .zip(path.file_name())
        .map_or_else(|| path.to_path_buf(), |(dir, name)| dir.join(name));
    match real.strip_prefix(&root) {
        Ok(rel) => Ok(rel.to_string_lossy().into_owned()),
        Err(_) => Err(io::Error::other(format!(
            "{target} isn't in this session's checkout"
        ))),
    }
}

/// A file, PR and attachment tab need their target, a Review tab may have one (its file), every other kind refuses one. A
/// file's is its file, relative and staying in the session's checkout; a PR's is its number, written plainly so one
/// PR is one tab [D1032].
fn check_target(kind: &str, target: Option<&str>) -> io::Result<()> {
    let ok = match (kind, target) {
        // shortcut: a string check, so a symlink in the checkout could lead out; resolve it when 2.23 reads the file.
        // A Review tab may open on one file [D1032, D1038].
        ("file" | "review", Some(path)) => {
            !path.contains('\0')
                && path
                    .split('/')
                    .all(|s| !s.is_empty() && s != "." && s != "..")
        }
        // `list`: the session's PRs when it has several [D205]; `owner/name#n`, another repository's [D213].
        ("pr", Some(target)) => target == "list" || core::host::pr_ref(target).is_some(),
        ("attachment", Some(target)) => target.split_once('/').is_some_and(|(id, name)| {
            core::check_id(id).is_ok() && !name.is_empty() && !name.contains(['/', '\0'])
        }),
        ("file" | "pr" | "attachment", None) => false,
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

/// `tabs <id> [open <tab> <kind> [<target>] | replace <tab> <kind> | file <tab> <path> <line|-> <keep|preview> |
/// keep <tab> | scope <tab> <scope> | select <tab> | close <tab> | close-others <tab> | close-right <tab> | move <tab> <to> |
/// reopen]`, for a session or Home.
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
            if let Some(Closed { mut tab, index }) = now.closed.pop()
                && !now.exists(&tab.id)
                && allowed(&tab.kind).is_ok()
            {
                if let Some(same) = now.same(&tab.kind, &tab.target) {
                    now.active = same;
                } else {
                    // One preview at a time: a closed one comes back kept if another is open.
                    tab.preview &= !now.tabs.iter().any(|t| t.preview);
                    now.active = tab.id.clone();
                    let index = index.min(now.tabs.len());
                    now.tabs.insert(index, tab);
                }
            }
        }
        "open" => {
            let (tab, kind) = (arg(args, 3)?, kind()?);
            let mut target = args.get(5).cloned();
            core::check_id(tab)?;
            if kind == "review" && !home {
                target = target.map(|t| relative(data, id, t)).transpose()?;
            }
            check_target(&kind, target.as_deref())?;
            if let Some(same) = now.same(&kind, &target) {
                // In place, keeping its id, so the bar doesn't flicker [D419, D424].
                if let Some(at) = now.at(&same) {
                    now.tabs[at].target = target;
                }
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
                            ..Tab::default()
                        },
                    );
                }
                now.active = tab.into();
            }
        }
        // A file already open comes to the front; else it opens beside, or in the preview's place.
        "file" => {
            let (tab, path) = (arg(args, 3)?, arg(args, 4)?);
            core::check_id(tab)?;
            check_target(FILE, Some(path))?;
            let line = match arg(args, 5)? {
                "-" => None,
                line => Some(line.parse().map_err(|_| io::Error::other(USAGE))?),
            };
            let preview = match arg(args, 6)? {
                "preview" => true,
                "keep" => false,
                _ => return Err(io::Error::other(USAGE)),
            };
            let target = Some(path.to_string());
            if let Some(at) = now.same(FILE, &target).and_then(|id| now.at(&id)) {
                let open = &mut now.tabs[at];
                open.preview &= preview;
                open.line = line.or(open.line);
                now.active = open.id.clone();
            } else {
                let file = Tab {
                    id: tab.into(),
                    kind: FILE.into(),
                    opener: now.active.clone(),
                    target,
                    line,
                    preview,
                    ..Tab::default()
                };
                // The preview keeps its id, so the bar doesn't grow a tab and shrink back [D419, D424].
                now.active = match now.tabs.iter().position(|t| t.preview).filter(|_| preview) {
                    Some(at) => {
                        let Tab { id, opener, .. } = now.tabs[at].clone();
                        now.tabs[at] = Tab {
                            id: id.clone(),
                            opener,
                            ..file
                        };
                        id
                    }
                    None => {
                        let index = now.at(&now.active).map_or(0, |at| at + 1);
                        now.tabs.insert(index, file);
                        tab.into()
                    }
                };
            }
        }
        "keep" => {
            if let Some(at) = now.at(arg(args, 3)?) {
                now.tabs[at].preview = false;
            }
        }
        "scope" => {
            let scope = arg(args, 4)?;
            if !["last", "uncommitted", "staged", "unstaged", "branch"].contains(&scope) {
                return Err(io::Error::other(format!("unknown scope {scope}")));
            }
            if let Some(at) = now
                .at(arg(args, 3)?)
                .filter(|&at| now.tabs[at].kind == "review")
            {
                now.tabs[at].scope = Some(scope.into());
            }
        }
        "replace" => {
            let (tab, kind) = (arg(args, 3)?, kind()?);
            // A New tab becomes what was picked on it: a kind with no target.
            check_target(&kind, None)?;
            // A kind there's one of, already open, comes to the front and the New tab stays.
            if let Some(same) = now.same(&kind, &None) {
                now.active = same;
            } else if let Some(at) = now.at(tab)
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
