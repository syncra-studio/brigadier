//! `draft <id> retry|adopt|drop <cid>`: a message on its way, from its bubble or queue row, each
//! under the message's own lock, so it waits for an attempt under way [D54, C58]. Home's, a new
//! chat from its row [C65].

use super::args::{has_opt, opt};
use super::verdict::there;
use super::{Going, How, Place, Words, attempt, change, files_of, opts, place, present, settle};
use crate::{USAGE, arg, flag, has};
use brigadier_core as core;
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// `retry <cid>` (Try again, Add again): the message's command as it ran, again under its id,
/// unless it's there already. `adopt <cid> --kind send|queue|start --op <json> --draft <json>
/// [--draft-rev R]`: the app's own copy of a message whose reply never came, kept here unless the
/// book or the session has it; acked either way, so the app lets its copy go. `drop <cid>`
/// (Discard, Delete, Edit).
pub fn ops(
    place: &Place,
    args: &[String],
    run: impl FnOnce(&[String]) -> io::Result<Value>,
) -> io::Result<Value> {
    let (id, cid) = (arg(args, 1)?, arg(args, 3)?);
    core::check_id(cid)?;
    place::resume(place)?;
    let _held = place::hold_cid(place, cid)?;
    if arg(args, 2)? == "drop" && may_have_reached(place, cid)? {
        // PROPOSED words.
        let error = "It may have reached the agent, so it can't be discarded. Try again sends it under the same id.";
        return Ok(json!({"ok": false, "maybe": true, "cid": cid, "error": error}));
    }
    match (arg(args, 2)?, place) {
        ("retry", _) => retry(place, id, cid, run),
        ("adopt", _) => adopt(place, args, id, cid),
        ("drop", Place::Session(dir)) => discard(place, dir, cid),
        ("drop", _) => place::discard(place, cid),
        _ => Err(io::Error::other(USAGE)),
    }
}

/// Whether send or start `cid` is on its way and a try of it may have reached a host: then it's
/// never discarded, only tried again under its id, which the host's dedupe holds [C75, D66].
fn may_have_reached(place: &Place, cid: &str) -> io::Result<bool> {
    change(place, |book| {
        Ok(book.find(cid).is_some_and(|(queue, g)| !queue && g.reached))
    })
}

/// Whether `op` is a command a retry may run for message `cid` of session `id`, or of Home's
/// draft `id`: the book is a file anything can write, so it runs only a send or queue add of this
/// session, or a start from this draft, under this id, and never one for a worker, a command or
/// another sender.
fn valid(place: &Place, op: &[String], id: &str, cid: &str, queue: bool) -> bool {
    let at = |i: usize| op.get(i).map(String::as_str);
    let mine = match (queue, place) {
        (true, Place::Session(_)) => {
            at(0) == Some("queue") && at(2) == Some("add") && opt(opts(op), "--qid") == Some(cid)
        }
        (false, Place::Session(_)) => at(0) == Some("send") && opt(opts(op), "--cid") == Some(cid),
        (false, Place::Home { .. }) => {
            at(0) == Some("start") && opt(opts(op), "--cid") == Some(cid) && place.at(op).is_some()
        }
        (true, Place::Home { .. }) => false,
    };
    // A queue add's parser reads these anywhere in it (queue.rs), its words too; a send's never.
    let banned = |b: &&str| {
        if queue {
            has(op, b)
        } else {
            has_opt(opts(op), b)
        }
    };
    let to = match place {
        Place::Session(_) => at(1),
        Place::Home { .. } => opt(opts(op), "--home"),
    };
    mine && to == Some(id)
        && !["--to", "--shell", "--origin", "--draft", "--draft-rev"]
            .iter()
            .any(banned)
}

impl super::Book {
    /// Whether the UI's saved words are message `g`'s: no save since it went, or those very words.
    pub(super) fn holds(&self, g: &Going) -> bool {
        g.rev
            .is_some_and(|r| self.ui.rev <= r || self.ui.words == g.words)
    }

    /// The UI's saved words go with message `g` when they're its own.
    pub(super) fn release(&mut self, g: &Going) {
        if self.holds(g) {
            self.ui.words = Words::default();
        }
    }
}

fn retry(
    place: &Place,
    id: &str,
    cid: &str,
    run: impl FnOnce(&[String]) -> io::Result<Value>,
) -> io::Result<Value> {
    let found = change(place, |book| {
        let again = book.refused.iter().any(|c| c == cid);
        Ok((again, book.find(cid).map(|(queue, g)| (queue, g.clone()))))
    })?;
    let again = json!({"ok": false, "logged": false, "given_back": true, "again": true, "cid": cid, "error": "This message was given back or discarded."});
    let (queue, g) = match found {
        (true, _) => return Ok(again),
        (false, None) => return Ok(json!({"ok": true, "result": "settled", "cid": cid})),
        (false, Some(found)) => found,
    };
    // There already: it went, and nothing runs.
    if place.at(&g.op).is_some_and(|d| there(&d, cid)) {
        change(place, |book| {
            let list = book.list(queue);
            if let Some(at) = list.iter().position(|each| each.cid == cid) {
                let g = list.remove(at);
                settle(book, g, How::Went, Value::Null, None);
            }
            Ok(())
        })?;
        return Ok(json!({"ok": true, "result": "went", "cid": cid}));
    }
    if !valid(place, &g.op, id, cid, queue) {
        let error = "This message can't be tried again here: discard or edit it.";
        return Ok(json!({"ok": false, "unsettled": true, "cid": cid, "error": error}));
    }
    // Tried again it's no longer the field's words: a save of them, none since, goes with it.
    change(place, |book| {
        book.release(&g);
        Ok(())
    })?;
    let g = Going {
        rev: None,
        error: Value::Null,
        ..g
    };
    attempt(place, queue, g, run)
}

fn adopt(place: &Place, args: &[String], id: &str, cid: &str) -> io::Result<Value> {
    let queue = match flag(args, "--kind") {
        Some("queue") => true,
        Some("send" | "start") => false,
        _ => return Err(io::Error::other(USAGE)),
    };
    let value = |name| flag(args, name).ok_or_else(|| io::Error::other(USAGE));
    let op: Vec<String> = serde_json::from_str(value("--op")?)?;
    let Some(dir) = place.at(&op).filter(|_| valid(place, &op, id, cid, queue)) else {
        return Err(io::Error::other("not a message's own command"));
    };
    let words: Words = serde_json::from_str(value("--draft")?)?;
    let files = files_of(place, &words)?;
    let made = change(place, |book| {
        if book.refused.iter().any(|c| c == cid) {
            return Ok(json!({"ok": true, "given_back": true, "cid": cid}));
        }
        if let Some((_, g)) = book.find(cid) {
            return Ok(json!({"ok": true, "kept": true, "reached": g.reached, "cid": cid}));
        }
        // Under draft.lock: read without the queue's lock, the queue first [§5.2].
        if present(&dir, cid) {
            return Ok(json!({"ok": true, "went": true, "cid": cid}));
        }
        // The field's revision it went from: a save of its words, none since, is its own.
        let (rev, reached) = (
            flag(args, "--draft-rev").and_then(|r| r.parse().ok()),
            false,
        );
        let g = Going {
            cid: cid.into(),
            rev,
            words,
            files,
            op: op.clone(),
            reached,
            error: Value::Null,
        };
        book.list(queue).push(g);
        Ok(json!({"ok": true, "kept": true, "reached": false, "cid": cid}))
    })?;
    // Its chips are its own while it waits, as a send's are: Try again takes no others.
    if made["kept"] == true {
        let chips: Vec<&str> = opt(opts(&op), "--chips").map_or(vec![], |c| c.split(',').collect());
        crate::chips::take(&dir, cid, id, &chips)?;
    }
    Ok(made)
}

/// Discards message `cid` wherever it waits. Queued, it's taken out in the lock a drain sends
/// under, so never midway; in the log, it's refused, as nothing unsends it. Gone from the book, a
/// give-back no save has shown the UI with it, its id is refused from then on, so a late request
/// or a Try again never runs it, and its chips wait again. Its files stay with the session.
fn discard(place: &Place, dir: &Path, cid: &str) -> io::Result<Value> {
    let pulled = crate::queue::pull(dir, cid)?;
    if !pulled && core::fold(dir, true).is_ok_and(|f| f.fold.cids.contains_key(cid)) {
        return Ok(
            json!({"ok": false, "logged": true, "cid": cid, "error": "It was already sent."}),
        );
    }
    change(place, |book| {
        // A save of its words, none since it went, goes with it.
        if let Some((_, g)) = book.find(cid).map(|(q, g)| (q, g.clone())) {
            book.release(&g);
        }
        for queue in [false, true] {
            book.list(queue).retain(|each| each.cid != cid);
        }
        book.given.retain(|g| g.cid != cid);
        book.refuse(cid);
        Ok(())
    })?;
    let chips = crate::chips::back(dir, cid)?;
    Ok(json!({"ok": true, "cid": cid, "chips": chips}))
}
