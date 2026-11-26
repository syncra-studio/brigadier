//! A session's unsent draft, one file (`draft`) changed under `draft.lock` [D109, D237, D363]: the
//! draft as the composer shows it (`parts`, `attachmentIds`), and its `book`. The book keeps the
//! composer's own last save (`ui`), what Rust gave back to it (`given`) until a save shows the
//! composer has it, and the messages on their way (`inflight`, `adding` for a queue add) until they
//! settle by one rule (verdict.rs). A send or queue add from the composer carries its draft
//! (`--draft`, `--draft-rev`) and its chips (`--chips`): kept with the command as it ran, it can be
//! tried again, adopted from the app's own copy or dropped (ops.rs); one its own command proves never
//! went comes back here, its files and chips with it, whatever the UI does meanwhile [D54, C58].
//! Home's drafts keep one too, for the new chats they start (place.rs) [C65].

mod args;
mod ops;
mod place;
mod unsent;
mod verdict;

use args::bare;
pub(crate) use args::{has_opt, opt, opts};
pub use ops::ops;
pub use place::Place;
use place::{Undo, crash_at, finish, hold};
pub(crate) use unsent::unsent;
use verdict::{How, answer, present, verdict};

use crate::{arg, flag};
use brigadier_core as core;
use brigadier_frames::lock_held;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;

/// How many given-back ids are kept: one comes again only from a bubble, which lives one app run.
const REFUSED: usize = 200;

#[derive(Serialize, Deserialize, Default, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Words {
    #[serde(default)]
    parts: Vec<Value>,
    #[serde(default)]
    attachment_ids: Vec<Value>,
}

impl Words {
    fn blank(&self) -> bool {
        let space = |p: &Value| p.as_str().is_some_and(|s| s.trim().is_empty());
        self.attachment_ids.is_empty() && self.parts.iter().all(space)
    }
}

#[derive(Serialize, Deserialize, Default)]
struct Ui {
    #[serde(flatten)]
    words: Words,
    #[serde(default)]
    rev: u64,
}

/// A message on its way: the draft it was sent from, the UI's revision when it was, its files not
/// sent before, which a give-back moves back, and its command as it ran, which a retry runs again.
#[derive(Serialize, Deserialize, Clone)]
struct Going {
    cid: String,
    /// None: not taken from the field (a retry), so never the UI's own words.
    rev: Option<u64>,
    #[serde(flatten)]
    words: Words,
    files: Vec<String>,
    /// Without its draft, its chips (`--chips`) still named. Empty in a book from before: such a
    /// message can only be discarded or edited.
    #[serde(default)]
    op: Vec<String>,
    /// An attempt may have reached a host; false only for one adopted from the app's copy. Before
    /// it was kept, any may have.
    #[serde(default = "yes")]
    reached: bool,
    /// Why a start refused on its first try stays: its session took work, kept until Discard.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    error: Value,
}

const fn yes() -> bool {
    true
}

/// A message given back; `done` once its files and chips are back too.
#[derive(Serialize, Deserialize, Clone)]
struct Given {
    cid: String,
    rev: u64,
    #[serde(flatten)]
    words: Words,
    files: Vec<String>,
    #[serde(default)]
    chips: Vec<Value>,
    #[serde(default)]
    error: Value,
    done: bool,
    /// A start's undo still under way (place.rs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    undo: Option<Undo>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Book {
    rev: u64,
    ui: Ui,
    given: Vec<Given>,
    refused: Vec<String>,
    inflight: Vec<Going>,
    adding: Vec<Going>,
}

impl Book {
    /// The messages on their way of one kind: queue adds, or sends and steers.
    fn list(&mut self, queue: bool) -> &mut Vec<Going> {
        match queue {
            true => &mut self.adding,
            false => &mut self.inflight,
        }
    }

    /// Message `cid` on its way, and whether it's a queue add.
    fn find(&self, cid: &str) -> Option<(bool, &Going)> {
        let mine = |g: &&Going| g.cid == cid;
        (self.inflight.iter().find(mine).map(|g| (false, g)))
            .or_else(|| self.adding.iter().find(mine).map(|g| (true, g)))
    }

    /// `cid` given back or discarded: never run again under it.
    fn refuse(&mut self, cid: &str) {
        if !self.refused.iter().any(|c| c == cid) {
            self.refused.push(cid.into());
        }
        let over = self.refused.len().saturating_sub(REFUSED);
        self.refused.drain(..over);
    }
}

fn read(path: &Path) -> Book {
    let v: Value = (fs::read(path).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    // Saved before its files were kept, a draft was its parts alone; before the book, all the UI's.
    let v = if v.is_array() { json!({"parts": v}) } else { v };
    match v.get("book") {
        Some(book) => serde_json::from_value(book.clone()).unwrap_or_default(),
        None => Book {
            ui: Ui {
                words: serde_json::from_value(v).unwrap_or_default(),
                rev: 0,
            },
            ..Book::default()
        },
    }
}

/// The draft as the composer shows it: what was given back, newest first, above the UI's own;
/// `read`, as the UI reads it: only those whose files and chips are back too, and none of the UI's
/// a message on its way still holds, no save since it went (as `settle` decides), so it never
/// shows both as words and as its bubble or row.
fn shown(book: &Book, read: bool) -> Words {
    let mut out = Words::default();
    let given = book.given.iter().rev().filter(|g| g.done || !read);
    let held = read
        && book
            .inflight
            .iter()
            .chain(&book.adding)
            .any(|g| book.holds(g));
    let all = given
        .map(|g| &g.words)
        .chain((!held).then_some(&book.ui.words));
    for w in all.filter(|w| !w.blank()) {
        if !out.parts.is_empty() && !w.parts.is_empty() {
            out.parts.push("\n\n".into());
        }
        out.parts.extend(w.parts.iter().cloned());
        for id in &w.attachment_ids {
            if !out.attachment_ids.contains(id) {
                out.attachment_ids.push(id.clone());
            }
        }
    }
    out
}

/// Changes `place`'s book under its lock, in one write, what was cut short settled first.
fn change<T>(place: &Place, f: impl FnOnce(&mut Book) -> io::Result<T>) -> io::Result<T> {
    let _lock = hold(&place.lock())?;
    let path = place.file();
    let mut book = read(&path);
    let was = serde_json::to_vec(&book)?;
    replay(place, &mut book)?;
    let out = f(&mut book)?;
    if serde_json::to_vec(&book)? != was {
        let mut file = serde_json::to_value(shown(&book, false))?;
        file["book"] = serde_json::to_value(&book)?;
        core::write_atomic(&path, &serde_json::to_vec(&file)?)?;
    }
    Ok(out)
}

/// What a command cut short left, settled: a message by its presence alone, as nothing else
/// proves where it is; a give-back already written by bringing its files and chips back, or a
/// start's undo by going on with it. Every command on the draft, its files or chips runs it first.
pub fn settle_cut(place: &Place) -> io::Result<()> {
    place::resume(place)?;
    change(place, |_| Ok(()))
}

/// Under draft.lock, so presence is read without the queue's lock, the queue first [§5.2]. A
/// message absent stays: a host outlives its sender, and an adopted one no writer has run [C58].
/// A start's undo goes on outside it (`place::resume`).
fn replay(place: &Place, book: &mut Book) -> io::Result<()> {
    let gone = |cid: &str| !lock_held(&place.cid_lock(cid));
    let went = |g: &Going| (place.at(&g.op)).is_some_and(|d| present(&d, &g.cid));
    for queue in [false, true] {
        let all = std::mem::take(book.list(queue));
        let (went, kept): (Vec<Going>, _) =
            (all.into_iter()).partition(|g| gone(&g.cid) && went(g));
        *book.list(queue) = kept;
        for g in went {
            settle(book, g, How::Went, Value::Null, None);
        }
    }
    if let Place::Session(dir) = place {
        for g in book.given.iter_mut().filter(|g| !g.done && gone(&g.cid)) {
            finish(dir, g)?;
        }
    }
    Ok(())
}

/// The messages session `dir` holds chips for: on their way, or given back with their chips still
/// to come back. Read without draft.lock, which a give-back holds while it takes the chips' lock;
/// the file is written whole.
pub(crate) fn holding(dir: &Path) -> Vec<String> {
    let book = read(&dir.join("draft"));
    let going = book.inflight.iter().chain(&book.adding).map(|g| &g.cid);
    let given = book.given.iter().filter(|g| !g.done).map(|g| &g.cid);
    going.chain(given).cloned().collect()
}

/// Settles message `g`: gone into the log or the queue, or refused and given back above the draft.
/// No save of the UI's since it was sent, what the UI holds is that message, or an older save of
/// it: it goes either way. A save of those very words is it too, its reply not back when it went.
fn settle(book: &mut Book, g: Going, how: How, error: Value, undo: Option<Undo>) -> Option<Given> {
    if how != How::Unknown {
        book.release(&g);
    }
    if how != How::Refused {
        return None;
    }
    book.rev += 1;
    book.refuse(&g.cid);
    let (cid, rev, words, files) = (g.cid, book.rev, g.words, g.files);
    let given = Given {
        cid,
        rev,
        words,
        files,
        chips: vec![],
        error,
        done: false,
        undo,
    };
    book.given.push(given.clone());
    Some(given)
}

/// `draft <id>`: the shown draft, its revision, the ids given back into it since the UI last saved,
/// which a reloaded UI holds already, and the messages on their way (`going`), which its bubbles and
/// queue rows show. `draft <id> <json|""> --base R --took <cid,…>`: the UI's save, taken only
/// from a UI that saw revision R and every message given back since; else nothing is written, and
/// the reply is stale with what it missed. Without `--base`, as before.
/// Home's (`start`): each with why it stays, if it does, and a start whose session couldn't go too,
/// named by its session alone, as only Discard goes on with it.
pub fn kept(place: &Place, args: &[String]) -> io::Result<Value> {
    place::resume(place)?;
    let Some(text) = args.get(2) else {
        return change(place, |book| {
            // One still bringing its files and chips back reaches the UI with its next save, stale.
            let given = book.given.iter().filter(|g| g.done);
            let cids: Vec<&String> = given.map(|g| &g.cid).collect();
            let home = place.home().is_some();
            let mut going: Vec<Value> = (book.inflight.iter().map(|g| (false, g)))
                .chain(book.adding.iter().map(|g| (true, g)))
                .map(|(queue, g)| {
                    let kind = ["send", "queue", "start"][usize::from(queue) + 2 * usize::from(home)];
                    json!({"cid": g.cid, "kind": kind, "op": g.op, "draft": g.words, "reached": g.reached, "error": g.error})
                })
                .collect();
            for (g, u) in (book.given.iter()).filter_map(|g| Some((g, g.undo.as_ref()?))) {
                let Some(why) = &u.error else { continue };
                let op = ["start", u.session.as_str()];
                going.push(json!({"cid": g.cid, "kind": "start", "op": op, "draft": g.words, "reached": true, "error": place::left(why), "left": true}));
            }
            let draft = serde_json::to_string(&shown(book, true))?;
            Ok(json!({"ok": true, "draft": draft, "rev": book.rev, "cids": cids, "going": going}))
        });
    };
    let took: Vec<&str> = flag(args, "--took").map_or(vec![], |t| t.split(',').collect());
    let words: Words = match text.as_str() {
        "" => Words::default(),
        text => serde_json::from_str(text)?,
    };
    let base = flag(args, "--base").map(|b| b.parse::<u64>().map_err(io::Error::other));
    let base = base.transpose()?;
    change(place, |book| {
        let missed: Vec<&Given> = (book.given.iter())
            // One still bringing its files and chips back is offered once it has.
            .filter(|g| base.is_some() && g.done && !took.contains(&g.cid.as_str()))
            .collect();
        if base.is_some_and(|b| b != book.rev) || !missed.is_empty() {
            let given: Vec<Value> = missed.iter().map(|g| reply_of(g)).collect();
            return Ok(json!({"ok": false, "stale": true, "rev": book.rev, "given": given}));
        }
        book.rev += 1;
        book.ui = Ui {
            words,
            rev: book.rev,
        };
        book.given.retain(|g| !g.done);
        Ok(json!({"ok": true, "rev": book.rev}))
    })
}

fn reply_of(g: &Given) -> Value {
    json!({"cid": g.cid, "rev": g.rev, "parts": g.words.parts, "attachmentIds": g.words.attachment_ids, "chips": g.chips, "error": g.error})
}

/// `send`, `queue add` and Home's `start` (`--home`). With `--draft`, what goes is kept in the book
/// first, its chips taken for it, and settled by its verdict (verdict.rs); one given back or
/// discarded before is refused again (`again`), never sent. A reply that isn't `ok` says whether
/// the message reached the log (`logged`), or that it's unsettled, so Try again goes under the same
/// id, which the host's dedupe holds [D54]. A message for a worker (`--to`) isn't kept: its
/// hand-over is out of the book's reach.
pub fn going(
    place: &Place,
    args: &[String],
    run: impl FnOnce(&[String]) -> io::Result<Value>,
) -> io::Result<Value> {
    let queue = arg(args, 0)? == "queue";
    let o = opts(args);
    let cid = opt(o, if queue { "--qid" } else { "--cid" });
    let draft = (opt(o, "--draft")).filter(|_| place.there() && opt(o, "--to").is_none());
    let (Some(cid), Some(draft)) = (cid, draft) else {
        if place.there() {
            settle_cut(place)?;
        }
        return run(&bare(args, false));
    };
    core::check_id(cid)?;
    let g = Going {
        cid: cid.into(),
        rev: opt(o, "--draft-rev").and_then(|r| r.parse().ok()),
        words: serde_json::from_str(draft)?,
        files: vec![],
        op: bare(args, true),
        reached: true,
        error: Value::Null,
    };
    place::resume(place)?;
    let _held = place::hold_cid(place, cid)?;
    attempt(place, queue, g, run)
}

/// Message `g`'s draft files a give-back brings back.
fn files_of(place: &Place, words: &Words) -> io::Result<Vec<String>> {
    Ok(place.files(&serde_json::to_value(words)?))
}

/// One attempt at message `g`, its lock held: kept in the book as reached, before anything can
/// reach a host, its chips taken, run, then settled by its verdict; given back, its files and chips
/// come back once.
fn attempt(
    place: &Place,
    queue: bool,
    mut g: Going,
    run: impl FnOnce(&[String]) -> io::Result<Value>,
) -> io::Result<Value> {
    let (cid, home) = (g.cid.clone(), place.home().is_some());
    let at = place
        .at(&g.op)
        .ok_or_else(|| io::Error::other(crate::USAGE))?;
    g.files = files_of(place, &g.words)?;
    let first = change(place, |book| {
        if book.refused.contains(&cid) {
            return Ok(None);
        }
        if book.list(!queue).iter().any(|each| each.cid == cid) {
            return Err(io::Error::other("Another kind of message has this id"));
        }
        let list = book.list(queue);
        let old = (list.iter().position(|each| each.cid == cid)).map(|at| list.remove(at));
        // A try cut short, or the one before this: the files it took are this one's.
        let taken = old.iter().flat_map(|o| &o.files);
        let taken: Vec<String> = taken.filter(|f| !g.files.contains(f)).cloned().collect();
        g.files.extend(taken);
        // This try may reach a host: an adopted one's retry included, so no later try is a first.
        g.reached = true;
        list.push(g.clone());
        Ok(Some(old.is_none_or(|o| !o.reached)))
    })?;
    let Some(first) = first else {
        let error = "This message was given back or discarded.";
        return Ok(
            json!({"ok": false, "logged": false, "given_back": true, "again": true, "cid": cid, "error": error}),
        );
    };
    crash_at(if home {
        "start:inflight"
    } else {
        "send:inflight"
    });
    let chips: Vec<&str> = opt(opts(&g.op), "--chips").map_or(vec![], |c| c.split(',').collect());
    let out = match crate::chips::take(&at, &cid, arg(&g.op, 1)?, &chips) {
        Ok(()) => run(&bare(&g.op, false)),
        Err(e) => Err(unsent(e)),
    };
    if queue {
        crash_at("queue-add:after");
    }
    let how = verdict(&at, queue, &cid, first, &out);
    let error: Value = match &out {
        Ok(r) => r["message"].as_str().or(r["error"].as_str()).into(),
        Err(e) => e.to_string().into(),
    };
    // A start refused whose session took work stays, with why, for Try again or Discard [C65, D35].
    let stays = home && how == How::Refused && !place::undoable(&at);
    let given = change(place, |book| {
        let list = book.list(queue);
        let Some(i) = list.iter().position(|each| each.cid == cid) else {
            return Ok(None);
        };
        // Why it stays, or why a try that proves nothing failed: shown again after a reload.
        if stays || (how == How::Unknown && !error.is_null()) {
            list[i].error = error.clone();
        }
        if how == How::Unknown || stays {
            return Ok(None);
        }
        let g = list.remove(i);
        let undo = home.then(|| place::intent(&g.op, false));
        Ok(settle(book, g, how, error, undo))
    })?;
    crash_at(if home { "start:intent" } else { "send:settled" });
    let mut reply = answer(out, how);
    let session = arg(&g.op, 1)?;
    if stays {
        reply["session"] = session.into();
    }
    if let Some(g) = given {
        match place::give(place, g)? {
            Ok(g) => {
                let back = reply_of(&g);
                reply["given_back"] = true.into();
                for key in ["cid", "rev", "parts", "attachmentIds", "chips"] {
                    reply[key] = back[key].clone();
                }
                if home {
                    // Said only once it's gone [C65].
                    reply["session"] = "none".into();
                }
            }
            Err(why) => {
                reply = json!({"ok": false, "logged": false, "left": true, "session": session, "cid": cid, "error": why});
            }
        }
    }
    Ok(reply)
}
