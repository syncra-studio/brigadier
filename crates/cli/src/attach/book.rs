//! A session's unsent draft, one file (`draft`) changed under `draft.lock` [D109, D237, D363]: the
//! draft as the composer shows it (`parts`, `attachmentIds`), and its `book`. The book keeps the
//! composer's own last save (`ui`), what Rust gave back to it (`given`) until a save shows the
//! composer has it, and the messages on their way (`inflight`, `adding` for a queue add) until they
//! settle. A send, steer, queue add or chip hand-off from the composer carries its draft
//! (`--draft`, `--draft-rev`): one that surely never reached the log comes back here, its files and
//! chips with it, whatever the UI does meanwhile; one cut short by a crash is settled by the log
//! the next time anything here is read or changed [D54].

use crate::{arg, flag};
use brigadier_core::{self as core, message};
use brigadier_frames::lock_held;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

/// How many given-back ids are kept: one comes again only from a bubble, which lives one app run.
const REFUSED: usize = 200;

/// An error before any host was asked to take the message: it surely never went.
#[derive(Debug)]
struct Unsent(String);

impl std::fmt::Display for Unsent {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Unsent {}

pub(crate) fn unsent(e: io::Error) -> io::Error {
    io::Error::new(e.kind(), Unsent(e.to_string()))
}

fn is_unsent(e: &io::Error) -> bool {
    e.get_ref().is_some_and(|inner| inner.is::<Unsent>())
}

#[derive(Serialize, Deserialize, Default, Clone)]
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

/// A message on its way: the draft it was sent from, the UI's revision when it was, and its files
/// not sent before, which a give-back moves back.
#[derive(Serialize, Deserialize, Clone)]
struct Going {
    cid: String,
    rev: u64,
    #[serde(flatten)]
    words: Words,
    files: Vec<String>,
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

#[derive(Clone, Copy, PartialEq)]
enum How {
    Went,
    Refused,
    Unknown,
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

/// The draft as the composer shows it: what was given back, newest first, above the UI's own.
fn shown(book: &Book) -> Words {
    let mut out = Words::default();
    let all = book.given.iter().rev().map(|g| &g.words);
    for w in all.chain([&book.ui.words]).filter(|w| !w.blank()) {
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

fn hold(path: &Path) -> io::Result<File> {
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)?;
    lock.lock()?;
    Ok(lock)
}

/// Held by the command sending `cid` until it has settled it: free, that command is gone.
fn cid_lock(dir: &Path, cid: &str) -> PathBuf {
    dir.join(format!("draft-{cid}.lock"))
}

/// Changes session `dir`'s book under its lock, in one write, what was cut short settled first.
fn change<T>(dir: &Path, f: impl FnOnce(&mut Book) -> io::Result<T>) -> io::Result<T> {
    let _lock = hold(&dir.join("draft.lock"))?;
    let path = dir.join("draft");
    let mut book = read(&path);
    let was = serde_json::to_vec(&book)?;
    replay(dir, &mut book)?;
    let out = f(&mut book)?;
    if serde_json::to_vec(&book)? != was {
        let mut file = serde_json::to_value(shown(&book))?;
        file["book"] = serde_json::to_value(&book)?;
        core::write_atomic(&path, &serde_json::to_vec(&file)?)?;
    }
    Ok(out)
}

/// What a command cut short left, settled: a send by the log, a queue add by the queue and the
/// log, a give-back by bringing its files and chips back. Every command on the session's draft,
/// files or chips runs it first.
pub fn settle_cut(dir: &Path) -> io::Result<()> {
    change(dir, |_| Ok(()))
}

fn replay(dir: &Path, book: &mut Book) -> io::Result<()> {
    let gone = |cid: &str| !lock_held(&cid_lock(dir, cid));
    for queue in [false, true] {
        let list = match queue {
            true => &mut book.adding,
            false => &mut book.inflight,
        };
        let (cut, live) = std::mem::take(list).into_iter().partition(|g| gone(&g.cid));
        *list = live;
        for g in cut {
            let went = logged(dir, &g.cid) || (queue && queued(dir, &g.cid));
            settle(
                book,
                g,
                if went { How::Went } else { How::Refused },
                Value::Null,
            );
        }
    }
    for g in book.given.iter_mut().filter(|g| !g.done && gone(&g.cid)) {
        finish(dir, g)?;
    }
    Ok(())
}

fn logged(dir: &Path, cid: &str) -> bool {
    core::fold(dir, true).is_ok_and(|f| f.fold.cids.contains_key(cid))
}

fn queued(dir: &Path, qid: &str) -> bool {
    let q = crate::queue::row(dir);
    let items = q["items"].as_array().into_iter().flatten();
    items.chain([&q["editing"]]).any(|i| i["id"] == qid)
}

/// Settles message `g`: gone into the log or the queue, or refused and given back above the draft.
/// No save of the UI's since it was sent, what the UI holds is that message, or an older save of
/// it: it goes either way.
fn settle(book: &mut Book, g: Going, how: How, error: Value) -> Option<Given> {
    if how != How::Unknown && book.ui.rev <= g.rev {
        book.ui.words = Words::default();
    }
    if how != How::Refused {
        return None;
    }
    book.rev += 1;
    book.refused.push(g.cid.clone());
    let over = book.refused.len().saturating_sub(REFUSED);
    book.refused.drain(..over);
    let (cid, rev, words, files) = (g.cid, book.rev, g.words, g.files);
    let given = Given {
        cid,
        rev,
        words,
        files,
        chips: vec![],
        error,
        done: false,
    };
    book.given.push(given.clone());
    Some(given)
}

/// A given-back message's files back in the draft's folder, then its chips waiting again; each
/// step is safe to repeat.
fn finish(dir: &Path, g: &mut Given) -> io::Result<()> {
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

/// Drill hook: the command dies at `point`.
fn crash_at(point: &str) {
    if std::env::var("BRIGADIER_CRASH_AT").is_ok_and(|at| at == point) {
        std::process::abort();
    }
}

/// `draft <id>`: the shown draft, its revision and the ids given back into it since the UI last
/// saved, which a reloaded UI holds already. `draft <id> <json|""> --base R --took <cid,…>`: the
/// UI's save, taken only from a UI that saw revision R and every message given back since; else
/// nothing is written, and the reply is stale with what it missed. Without `--base`, as before.
pub fn kept(dir: &Path, args: &[String]) -> io::Result<Value> {
    let Some(text) = args.get(2) else {
        return change(dir, |book| {
            let cids: Vec<&String> = book.given.iter().map(|g| &g.cid).collect();
            let draft = serde_json::to_string(&shown(book))?;
            Ok(json!({"ok": true, "draft": draft, "rev": book.rev, "cids": cids}))
        });
    };
    let words: Words = match text.as_str() {
        "" => Words::default(),
        text => serde_json::from_str(text)?,
    };
    let base = flag(args, "--base").map(|b| b.parse::<u64>().map_err(io::Error::other));
    let base = base.transpose()?;
    let took: Vec<&str> = flag(args, "--took").map_or(vec![], |t| t.split(',').collect());
    change(dir, |book| {
        let missed: Vec<&Given> = (book.given.iter())
            .filter(|g| base.is_some() && !took.contains(&g.cid.as_str()))
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
        book.given.clear();
        Ok(json!({"ok": true, "rev": book.rev}))
    })
}

fn reply_of(g: &Given) -> Value {
    json!({"cid": g.cid, "rev": g.rev, "parts": g.words.parts, "attachmentIds": g.words.attachment_ids, "chips": g.chips, "error": g.error})
}

/// `send`, `chips take` and `queue add`. With `--draft`, what goes is kept in the book first, and a
/// refusal gives it back (`given_back`); one given back before is refused again (`again`), never
/// sent. A reply that isn't `ok` says whether the message reached the log (`logged`): after any
/// host's answer the log alone decides; before any host was asked, it didn't; with no answer, or
/// an error after a host may have taken it, it's unknown and `logged` is absent, so Try again goes
/// under the same id, which the host's dedupe holds [D54].
pub fn going(
    dir: &Path,
    args: &[String],
    run: impl FnOnce(&[String]) -> io::Result<Value>,
) -> io::Result<Value> {
    let kind = arg(args, 0)?;
    let cid = match kind {
        "chips" => args
            .get(3)
            .filter(|_| args[2] == "take")
            .map(String::as_str),
        "queue" => flag(args, "--qid"),
        _ => flag(args, "--cid"),
    };
    let draft = flag(args, "--draft").filter(|_| dir.is_dir());
    let (Some(cid), Some(draft)) = (cid, draft) else {
        if dir.is_dir() {
            settle_cut(dir)?;
        }
        let out = run(args);
        return match (kind, cid) {
            ("send", Some(cid)) => {
                let how = how(dir, kind, cid, &out);
                answer(out, how)
            }
            _ => out,
        };
    };
    core::check_id(cid)?;
    let words: Words = serde_json::from_str(draft)?;
    let rev = flag(args, "--draft-rev")
        .and_then(|r| r.parse().ok())
        .unwrap_or(0);
    let held = hold(&cid_lock(dir, cid))?;
    let sent = message::sent(dir);
    let files = (message::ids(&serde_json::to_value(&words)?).into_iter())
        .filter(|f| message::file_in(&sent, f).is_none())
        .collect();
    let g = Going {
        cid: cid.into(),
        rev,
        words,
        files,
    };
    let queue = kind == "queue";
    let again = change(dir, |book| {
        if book.refused.iter().any(|c| c == cid) {
            return Ok(true);
        }
        let list = if queue {
            &mut book.adding
        } else {
            &mut book.inflight
        };
        list.retain(|each| each.cid != cid);
        list.push(g);
        Ok(false)
    })?;
    if again {
        let error = "This message was given back to the draft.";
        return Ok(
            json!({"ok": false, "logged": false, "given_back": true, "again": true, "cid": cid, "error": error}),
        );
    }
    crash_at("send:inflight");
    let mut bare = vec![];
    let mut each = args.iter();
    while let Some(a) = each.next() {
        match a.as_str() {
            "--draft" | "--draft-rev" => drop(each.next()),
            _ => bare.push(a.clone()),
        }
    }
    let out = run(&bare);
    if queue {
        crash_at("queue-add:after");
    }
    let how = how(dir, kind, cid, &out);
    let error = match &out {
        Ok(r) => r["message"].as_str().or(r["error"].as_str()).into(),
        Err(e) => e.to_string().into(),
    };
    let given = change(dir, |book| {
        let list = if queue {
            &mut book.adding
        } else {
            &mut book.inflight
        };
        Ok(match list.iter().position(|each| each.cid == cid) {
            Some(at) => {
                let g = list.remove(at);
                settle(book, g, how, error)
            }
            None => None,
        })
    })?;
    crash_at("send:settled");
    let mut reply = answer(out, how);
    if let Some(mut g) = given {
        finish(dir, &mut g)?;
        change(dir, |book| {
            if let Some(kept) = book.given.iter_mut().find(|each| each.cid == g.cid) {
                (kept.chips, kept.done) = (g.chips.clone(), true);
            }
            Ok(())
        })?;
        if let Ok(reply) = &mut reply {
            let back = reply_of(&g);
            reply["given_back"] = true.into();
            for key in ["cid", "rev", "parts", "attachmentIds", "chips"] {
                reply[key] = back[key].clone();
            }
        }
    }
    drop(held);
    let _ = fs::remove_file(cid_lock(dir, cid));
    reply
}

fn how(dir: &Path, kind: &str, cid: &str, out: &io::Result<Value>) -> How {
    let went = |yes: bool| if yes { How::Went } else { How::Refused };
    match out {
        Ok(r) if r["ok"] == true => How::Went,
        // A queue add Rust refused never got in: neither the queue nor the log has it.
        _ if kind == "queue" => went(queued(dir, cid) || logged(dir, cid)),
        // A hand-off refused took nothing: its message never went.
        _ if kind == "chips" => How::Refused,
        Ok(r) if r["answered"] == false => How::Unknown,
        Ok(_) => went(logged(dir, cid)),
        Err(e) if is_unsent(e) => How::Refused,
        Err(_) => How::Unknown,
    }
}

/// The command's reply with `logged`, where it's known.
fn answer(out: io::Result<Value>, how: How) -> io::Result<Value> {
    let mut reply = match out {
        Ok(reply) => reply,
        Err(e) if how == How::Refused => json!({"ok": false, "error": e.to_string()}),
        Err(e) => return Err(e),
    };
    if reply["ok"] != true && how != How::Unknown {
        reply["logged"] = (how == How::Went).into();
    }
    Ok(reply)
}
