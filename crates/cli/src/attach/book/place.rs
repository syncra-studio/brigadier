//! Where a draft's book is [C65]: a session's folder (`draft`, `draft.lock`, `draft-<cid>.lock`),
//! or one of Home's drafts (`home-draft[-<p>]`, its locks beside it). Home's keeps the new chats it
//! starts (`start`), as the session one makes may never be, or may go. A start refused on its first
//! try is undone in stages, each saved before the next, so a crash goes on from the last one saved:
//! its files and tabs back, then its session deleted, then its words shown [D35, D363].

use super::args::{has_opt, opt};
use super::verdict::How;
use super::{Book, Given, Going, change, opts, read, settle};
use brigadier_core::{self as core, message};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};

pub enum Place {
    Session(PathBuf),
    /// Home's draft file, and the data folder the sessions it starts are in.
    Home {
        data: PathBuf,
        file: PathBuf,
    },
}

impl Place {
    pub(crate) fn file(&self) -> PathBuf {
        match self {
            Place::Session(dir) => dir.join("draft"),
            Place::Home { file, .. } => file.clone(),
        }
    }

    fn beside(&self, end: &str) -> PathBuf {
        let mut name = self.file().into_os_string();
        name.push(end);
        name.into()
    }

    pub(super) fn lock(&self) -> PathBuf {
        self.beside(".lock")
    }

    /// Held by the command for `cid` until it has settled it: free, that command is gone. Its file
    /// stays: a retry already waiting on it, and replay, must see the same one.
    pub(super) fn cid_lock(&self, cid: &str) -> PathBuf {
        self.beside(&format!("-{cid}.lock"))
    }

    /// Whether the book has a place: a session's folder must be there.
    pub(super) fn there(&self) -> bool {
        match self {
            Place::Session(dir) => dir.is_dir(),
            Place::Home { .. } => true,
        }
    }

    pub(crate) fn home(&self) -> Option<&Path> {
        match self {
            Place::Session(_) => None,
            Place::Home { data, .. } => Some(data),
        }
    }

    /// The session message `op` goes to, whose queue and log show it went: this one, or the one a
    /// start makes. The book is a file anything can write, so its id is checked first.
    pub(super) fn at(&self, op: &[String]) -> Option<PathBuf> {
        match self {
            Place::Session(dir) => Some(dir.clone()),
            Place::Home { data, .. } => (op.get(1))
                .filter(|id| core::check_id(id).is_ok())
                .map(|id| core::session_dir(data, id)),
        }
    }

    /// Message `words`' files a give-back brings back: a session's not sent before; all of Home's.
    pub(super) fn files(&self, words: &Value) -> Vec<String> {
        let ids = message::ids(words).into_iter();
        match self {
            Place::Session(dir) => {
                let sent = message::sent(dir);
                ids.filter(|f| message::file_in(&sent, f).is_none())
                    .collect()
            }
            Place::Home { .. } => ids.collect(),
        }
    }
}

pub(super) fn hold(path: &Path) -> io::Result<File> {
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)?;
    lock.lock()?;
    Ok(lock)
}

/// A start's undo, as far as it got.
#[derive(Serialize, Deserialize, Clone)]
pub(super) struct Undo {
    /// "intent": nothing moved yet; "back": its files and tabs are Home's again.
    stage: String,
    pub(super) session: String,
    parts: Value,
    tabs: bool,
    /// The user's Discard, which deletes whatever is left of the session; else only one that holds
    /// nothing goes.
    #[serde(default)]
    asked: bool,
    /// Why its session couldn't go: tried again by Discard alone, never on every read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
}

/// Start `op`'s undo, before anything of it moves: so Home's draft names its files (`sweep_home`).
pub(super) fn intent(op: &[String], asked: bool) -> Undo {
    let o = opts(op);
    Undo {
        stage: "intent".into(),
        session: op.get(1).cloned().unwrap_or_default(),
        parts: (opt(o, "--parts").and_then(|p| serde_json::from_str(p).ok())).unwrap_or_default(),
        tabs: has_opt(o, "--carry-tabs"),
        asked,
        error: None,
    }
}

/// Whether session `dir` holds nothing yet: never made, or no worktree and nothing in its log. A
/// start's own refusal then leaves nothing of it worth keeping; one that took git work stays [D35].
pub(super) fn undoable(dir: &Path) -> bool {
    !dir.join("session.json").exists()
        || (!dir.join(core::worktrees::RECORD).exists()
            && core::fold(dir, true).is_ok_and(|f| f.fold.cids.is_empty()))
}

/// PROPOSED: what a start's row says when its session couldn't go.
pub(super) fn left(why: &str) -> String {
    format!("Couldn't remove it: {why}")
}

/// Given-back message `g` brought home, its lock held: a session's files and chips back, or a
/// start's undo. Its words, or why its session stays.
pub(super) fn give(place: &Place, mut g: Given) -> io::Result<Result<Given, String>> {
    let Place::Session(dir) = place else {
        return undo(place, &g.cid, false);
    };
    finish(dir, &mut g)?;
    change(place, |book| {
        if let Some(kept) = book.given.iter_mut().find(|each| each.cid == g.cid) {
            (kept.chips, kept.done) = (g.chips.clone(), true);
        }
        Ok(())
    })?;
    Ok(Ok(g))
}

/// A given-back message's files back in the draft's folder, then its chips waiting again; each
/// step is safe to repeat.
pub(super) fn finish(dir: &Path, g: &mut Given) -> io::Result<()> {
    let (sent, draft) = (message::sent(dir), message::draft(dir));
    for id in &g.files {
        if message::file_in(&sent, id).is_some() && !draft.join(id).exists() {
            fs::create_dir_all(&draft)?;
            fs::rename(sent.join(id), draft.join(id))?;
        }
    }
    crash_at("send:files");
    let back = crate::chips::back(dir, &g.cid)?;
    if !back.is_empty() {
        g.chips = back;
    }
    g.done = true;
    Ok(())
}

/// Start `cid`'s give-back from its saved stage, its lock held and never the draft's: its files and
/// tabs back to Home while its session is there to give them, then the session through the delete
/// a user's runs, which stops its host first; only then are its words shown. A replay of one Rust
/// started on its own checks again that the session holds nothing, as the file is anyone's.
pub(super) fn undo(place: &Place, cid: &str, replay: bool) -> io::Result<Result<Given, String>> {
    let data = place.home().expect("a start's undo is Home's");
    let Some(g) = change(place, |book| Ok(mine(book, cid).cloned()))? else {
        return Ok(Err(left("it isn't here any more")));
    };
    let Some(u) = g.undo.clone() else {
        return Ok(Ok(g));
    };
    let stage = |f: &dyn Fn(&mut Given)| change(place, |book| Ok(mine(book, cid).map(f)));
    let fail = |why: String| -> io::Result<Result<Given, String>> {
        stage(&|g| g.undo.iter_mut().for_each(|u| u.error = Some(why.clone())))?;
        Ok(Err(left(&why)))
    };
    if core::check_id(&u.session).is_err() {
        return fail("it names no session".into());
    }
    let dir = core::session_dir(data, &u.session);
    if u.stage == "intent" {
        if dir.join("session.json").exists() {
            let spec = core::load(data, &u.session);
            if let Err(e) = spec.and_then(|s| crate::attach::back(data, &s, &u.parts, u.tabs)) {
                return fail(e.to_string());
            }
        }
        // Tabs may not be safe to give back twice: a replay from here on skips them.
        stage(&|g| g.undo.iter_mut().for_each(|u| u.stage = "back".into()))?;
        crash_at("start:back");
    }
    if replay && !u.asked && !undoable(&dir) {
        return fail("it was used meanwhile".into());
    }
    let args = ["delete", &u.session].map(String::from);
    match crate::sessions::run(data, &args) {
        Ok(r) if r["ok"] == true => {}
        Ok(r) => return fail(reason(&r)),
        Err(e) => return fail(e.to_string()),
    }
    crash_at("start:deleted");
    let done = change(place, |book| {
        Ok(mine(book, cid).map(|g| {
            (g.done, g.undo) = (true, None);
            g.clone()
        }))
    })?;
    Ok(done.ok_or_else(|| left("it isn't here any more")))
}

fn mine<'a>(book: &'a mut Book, cid: &str) -> Option<&'a mut Given> {
    book.given.iter_mut().find(|g| g.cid == cid)
}

fn reason(reply: &Value) -> String {
    let left = reply["left"].as_array().into_iter().flatten();
    let left: Vec<&str> = left.filter_map(Value::as_str).collect();
    match left.is_empty() {
        true => reply["error"].as_str().unwrap_or("it was refused").into(),
        false => left.join("; "),
    }
}

/// Home's give-backs a command cut short, carried on from their saved stage: collected under the
/// draft's lock, each run under its message's, skipped while that's held, and never under the
/// draft's, as delete takes other locks. One whose session couldn't go waits for Discard.
pub(super) fn resume(place: &Place) -> io::Result<()> {
    if place.home().is_none() {
        return Ok(());
    }
    let cut = change(place, |book| {
        let waiting = |g: &&Given| !g.done && g.undo.as_ref().is_some_and(|u| u.error.is_none());
        Ok((book.given.iter().filter(waiting))
            .map(|g| g.cid.clone())
            .collect::<Vec<_>>())
    })?;
    for cid in cut {
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(place.cid_lock(&cid))?;
        match lock.try_lock() {
            Ok(()) => drop(undo(place, &cid, true)?),
            Err(TryLockError::WouldBlock) => {}
            Err(TryLockError::Error(e)) => return Err(e),
        }
    }
    Ok(())
}

/// Discard of a start (`drop`), its lock held: in its session's log it went, and stays; else what
/// is left of its session goes as a refused one's does, and its words come back to Home [C65].
pub(super) fn discard(place: &Place, cid: &str) -> io::Result<Value> {
    let found = change(place, |book| Ok(book.find(cid).map(|(_, g)| g.clone())))?;
    let logged = |g: &Going| {
        (place.at(&g.op))
            .is_some_and(|d| core::fold(&d, true).is_ok_and(|f| f.fold.cids.contains_key(cid)))
    };
    if found.as_ref().is_some_and(logged) {
        return Ok(
            json!({"ok": false, "logged": true, "cid": cid, "error": "It was already sent."}),
        );
    }
    let session = change(place, |book| {
        if let Some(g) = found {
            book.inflight.retain(|each| each.cid != cid);
            let (session, undo) = (g.op.get(1).cloned(), intent(&g.op, true));
            settle(book, g, How::Refused, Value::Null, Some(undo));
            return Ok(session);
        }
        book.refuse(cid);
        let given = book.given.iter_mut().find(|g| g.cid == cid);
        let undo = given.and_then(|g| g.undo.as_mut());
        Ok(undo.map(|u| {
            (u.error, u.asked) = (None, true);
            u.session.clone()
        }))
    })?;
    crash_at("start:intent");
    if session.is_some() {
        return Ok(match undo(place, cid, false)? {
            Ok(g) => given_back(&g),
            Err(why) => {
                json!({"ok": false, "left": true, "session": session, "cid": cid, "error": why})
            }
        });
    }
    // Back already, or never here: what's back shows with the draft's next read or save.
    let book = read(&place.file());
    Ok(match book.given.iter().find(|g| g.cid == cid) {
        Some(g) => given_back(g),
        None => json!({"ok": true, "cid": cid}),
    })
}

fn given_back(g: &Given) -> Value {
    let mut reply = super::reply_of(g);
    (reply["ok"], reply["given_back"], reply["session"]) =
        (true.into(), true.into(), "none".into());
    reply
}

/// Drill hook: the command dies at `point`.
pub(super) fn crash_at(point: &str) {
    if std::env::var("BRIGADIER_CRASH_AT").is_ok_and(|at| at == point) {
        std::process::abort();
    }
}
