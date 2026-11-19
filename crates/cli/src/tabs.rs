//! The tabs over a chat or session, one system for both [D360, D361]: which are open, their order
//! and which is in front, kept in the session's folder and gone with it [D35]. Home's live beside
//! its draft. The Chat tab is implied, always first. Every change is safe to send twice, except
//! `reopen`, and answers the whole state with a `rev` that only grows, so the app can tell Rust's
//! newer word from an older one after a lost reply [D30, D71].

mod home;
pub(crate) mod target;

pub use home::carry;
use home::is_home;

use crate::{HOME_DRAFT, USAGE, arg};
use brigadier_core::{self as core, projects, session, worktrees};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use target::{check_target, relative};

const CHAT: &str = "chat";
/// The old app's New tab chooser, and a terminal, drawn only for now [D361]; a pull request with its
/// number, or `list` for the session's PRs [D205]; the Review diff [D1014, D1032]; an attachment, `<id>/<its name>`, as the old app opened a
/// pasted text or a text file in a tab, and now every file that isn't an image [D2098, D2104]; the
/// card's Background history [D200]; a note, by its id [D244]; the session repository's Actions [D264]; a web page, by
/// its address [D2002]; the Mockup tab, by its mockup worker [D2066].
const KINDS: [&str; 10] = [
    "new",
    "terminal",
    "pr",
    "review",
    "attachment",
    "background",
    "note",
    "actions",
    "browser",
    "mockup",
];
const TERMINAL: &str = "terminal";
const NEW: &str = "new";
/// A checkout file, opened by `file` only, as it needs a line and a preview too [D1002, D1032].
const FILE: &str = "file";
const CLOSED_KEPT: usize = 20;
/// Kinds a session has one of: opening one again brings it to the front, on its new target [D478, D1114].
const ONE: [&str; 4] = ["review", "background", "actions", "mockup"];

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
    /// A browser tab's profile; none is the default one [D516].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    profile: Option<String>,
    /// The session of the agent working a browser tab, its own or a worker's; none for the user's own [D516].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    driver: Option<String>,
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
    if let Some(project) = id.strip_prefix("@home:") {
        data.join(format!("home-tabs-{project}.json"))
    } else if id == HOME_DRAFT {
        data.join("home-tabs.json")
    } else {
        core::session_dir(data, id).join("tabs.json")
    }
}

/// Commands run at once on the daemon's threads: every change holds the session's lifecycle lock,
/// so it can't overwrite another or land on a session being archived or deleted [D35].
fn lock(data: &Path, id: &str) -> io::Result<File> {
    if is_home(id) {
        projects::lock(data, "home-tabs.lock")
    } else {
        worktrees::lock(&core::session_dir(data, id))
    }
}

/// None yet, or not readable as tabs: only the Chat tab, which is never lost.
fn read(path: &Path) -> Tabs {
    let mut tabs: Tabs = crate::workers::read_json(path).unwrap_or_default();
    // A saved tab of a kind this build no longer draws would crash the app: it's dropped [D30].
    let known = |t: &Tab| t.kind == FILE || KINDS.contains(&t.kind.as_str());
    tabs.tabs.retain(known);
    tabs.closed.retain(|c| known(&c.tab));
    // A profile names the browser's storage folder (main's browser/profiles.ts): one that isn't plain is the default.
    let plain = |id: &str| {
        (1..=64).contains(&id.len())
            && (id.bytes()).all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    let saved = tabs.closed.iter_mut().map(|c| &mut c.tab);
    for tab in tabs.tabs.iter_mut().chain(saved) {
        if !tab.profile.as_deref().is_none_or(plain) {
            tab.profile = None;
        }
        if tab
            .driver
            .as_deref()
            .is_some_and(|d| core::check_id(d).is_err())
        {
            tab.driver = None;
        }
    }
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

/// `tabs <id> [open <tab> <kind> [<target>] | replace <tab> <kind> [<target>] | url <tab> <url> | drive <tab> <url> <driver> | user <tab> | file <tab> <path> <line|-> <keep|preview> |
/// keep <tab> | scope <tab> <scope> | select <tab> | close <tab> | close-others <tab> | close-right <tab> | move <tab> <to> |
/// reopen] [--behind]`, for a session or Home; `--behind` keeps the tab in front, as a worker's `show` [D519].
pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    let path = file(data, id);
    let Some(op) = args.get(2).map(String::as_str) else {
        return Ok(state(&read(&path)));
    };
    let _one = lock(data, id)?;
    let home = is_home(id);
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
            // A New tab becomes what was picked on it, or the page typed in it.
            let target = args.get(5).cloned();
            check_target(&kind, target.as_deref())?;
            // One already open (a kind there's one of, a PR, a note) comes to the front and the New tab stays; a typed page
            // opens here even if another tab shows it.
            let key = target.clone().filter(|_| kind != "browser");
            if let Some(same) = now.same(&kind, &key) {
                now.active = same;
            } else if let Some(at) = now.at(tab)
                && now.tabs[at].kind == NEW
            {
                now.tabs[at].kind = kind;
                now.tabs[at].target = target;
                now.active = tab.into();
            }
        }
        // A browser tab follows its page, so it opens there again after a restart.
        "url" => {
            let (tab, url) = (arg(args, 3)?, arg(args, 4)?);
            check_target("browser", Some(url))?;
            if let Some(at) = now.at(tab).filter(|&at| now.tabs[at].kind == "browser") {
                now.tabs[at].target = Some(url.into());
            }
        }
        "profile" => {
            let profile = arg(args, 4)?;
            crate::browser::profiles::check_id(profile)?;
            let at = now
                .at(arg(args, 3)?)
                .filter(|&at| now.tabs[at].kind == "browser")
                .ok_or_else(|| io::Error::other("No such browser tab"))?;
            now.tabs[at].profile = Some(profile.into());
        }
        "drive" => now.drive(arg(args, 3)?, arg(args, 4)?, arg(args, 5)?)?,
        // The user takes a tab back from the agent working it: theirs again [D775].
        "user" => {
            if let Some(at) = now
                .at(arg(args, 3)?)
                .filter(|&at| now.tabs[at].kind == "browser")
            {
                now.tabs[at].driver = None;
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
    crate::has(args, "--behind").then(|| now.active.clone_from(&was.active));
    if now != was {
        now.rev = was.rev + 1;
        write(&path, &now)?;
    }
    // A note closed before the first message goes with its tab: there's no session to list it [D280].
    if home {
        home::drop_closed_notes(data);
    }
    Ok(state(&now))
}

/// Session `session`'s browser tabs on a web page, for the `@` menu: id, address and who works it.
pub(crate) fn browser(data: &Path, session: &str) -> Vec<(String, String, Option<String>)> {
    (read(&file(data, session)).tabs.into_iter())
        .filter(|t| t.kind == "browser")
        .filter_map(|t| Some((t.id, t.target.filter(|u| u.starts_with("http"))?, t.driver)))
        .collect()
}

/// A browser tab's saved pin; the registry decides whether it is still live.
pub(crate) fn profile(data: &Path, session: &str, tab: &str) -> Option<String> {
    read(&file(data, session))
        .tabs
        .into_iter()
        .find(|t| t.id == tab && t.kind == "browser")?
        .profile
}
