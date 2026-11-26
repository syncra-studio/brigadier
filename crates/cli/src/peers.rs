//! Messages between sessions [D2034, D2035, D3014]: `brigadier send <id> "…" [--wait]` steers the
//! message into the receiver's running turn, never its user's queue, or starts its next turn. It
//! goes as `peer:<sender>`, never as the user, so it answers and approves nothing.
//!
//! Delivered once across restarts, on the delivery rules [D54, D82, D237]: the message's id is its
//! queue item's id and its steer's command id all the way through. The sender's record
//! (`peers/out/<id>.json`) is written first; the receiver's (`peers/in/<id>.json`) under the
//! receiver's queue lock, which drops a repeat. The daemon's pass finishes any message a restart
//! cut short and settles each by the receiver's log; one never proven taken is uncertain and never
//! sent again by itself. A chain stops at 8 hops and a sender at 20 a minute; only the user's
//! Send anyway lets that message through.

mod finish;
mod first;
pub mod held;
mod reply;

use crate::{control, owner, queue, workers};
use brigadier_core::{self as core, adapters};
use brigadier_frames::log;
pub(crate) use first::begin;
pub(crate) use held::{hand_all, written};
pub(crate) use reply::{answer, question};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;

/// The most hops a chain between sessions takes; the 9th stops [D2034].
const HOPS: u64 = 8;
/// Proposed: the most messages a session sends in a minute (the old plan's 20).
const RATE: usize = 20;
/// Proposed: the longest message, as the longest reply.
const MOST: usize = 16 << 10;

#[derive(Serialize, Deserialize, Clone, Default)]
struct Out {
    mid: String,
    to: String,
    text: String,
    hop: u64,
    at: u64,
    #[serde(default)]
    wait: bool,
    /// written | sent (in its queue or turn) | delivered | uncertain | dropped | stopped; a worker's
    /// question to its parent: asking (its send waits) | asked (it stopped waiting) | answered
    state: String,
    /// Why it stopped (hops | rate) or was dropped.
    #[serde(default)]
    why: Option<String>,
    /// The parent's answer to its worker's question.
    #[serde(default)]
    reply: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct In {
    mid: String,
    from: String,
    hop: u64,
    at: u64,
    /// queue | steer
    how: String,
    /// The receiver's turn it was steered into.
    #[serde(default)]
    turn: Option<String>,
    /// adding | held (for its running turn) | queued | steering | delivered | uncertain | dropped
    state: String,
}

fn path(data: &Path, id: &str, way: &str, mid: &str) -> PathBuf {
    core::session_dir(data, id)
        .join("peers")
        .join(way)
        .join(format!("{mid}.json"))
}

fn save<T: Serialize>(data: &Path, id: &str, way: &str, mid: &str, v: &T) -> io::Result<()> {
    let p = path(data, id, way, mid);
    fs::create_dir_all(p.parent().unwrap())?;
    workers::write_json(&p, v)
}

fn all<T: for<'a> Deserialize<'a>>(data: &Path, id: &str, way: &str) -> Vec<T> {
    let dir = core::session_dir(data, id).join("peers").join(way);
    (fs::read_dir(dir).into_iter().flatten())
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json")) // never one half written
        .filter_map(|e| workers::read_json(&e.path()))
        .collect()
}

/// Drill hook: die at a step, as the host's `after_intent:`.
fn crash_at(step: &str) {
    if std::env::var("BRIGADIER_CRASH_AT").is_ok_and(|at| at == format!("peer:{step}")) {
        std::process::abort();
    }
}

/// A row in the sender's thread, as a note in its log; the thread folds them by message [D3014].
fn note(data: &Path, id: &str, mut v: Value) {
    v["event"] = "peer".into();
    if let Ok(spec) = core::load(data, id) {
        let _ = owner::ensure(data, &spec);
        let _ = owner::call(data, id, json!({"op": "note", "data": v}));
    }
}

/// The hop a session's turn carries: the most of what started or joined it, from another session
/// or a worker's result; a turn the user started is 0.
pub(crate) fn hop_of(data: &Path, id: &str, turn: &str) -> u64 {
    let ins = all::<In>(data, id, "in").into_iter();
    let joined = ins.filter(|i| i.mid == turn || i.turn.as_deref() == Some(turn));
    let result = workers::result_hop(data, id, turn).unwrap_or(0);
    joined.map(|i| i.hop).max().unwrap_or(0).max(result)
}

fn refuse(error: &str) -> Value {
    json!({"ok": false, "error": error})
}

/// The agent's `send` [D2026, D2034]. `row` is the receiver's; `wait` its timeout, in seconds.
pub fn send(
    data: &Path,
    me: &str,
    row: &Value,
    text: &str,
    wait: Option<u64>,
    here: &dyn Fn() -> bool,
) -> Value {
    let to = row["id"].as_str().unwrap_or("");
    let refused = |why: &str| {
        note(
            data,
            me,
            json!({"phase": "refused", "to": to, "text": text, "why": why}),
        );
        refuse(why)
    };
    // Proposed: neither yourself nor an archived session.
    if to == me {
        return refused("That's you. `brigadier sessions` lists the others.");
    }
    if !matches!(row["archived"], Value::Null | Value::Bool(false)) {
        return refused(&format!(
            "{to} is archived. Only the user can bring it back."
        ));
    }
    if text.trim().is_empty() {
        return refuse("Give the message: brigadier send <id> \"…\".");
    }
    if text.len() > MOST {
        return refuse("Keep a message under 16 KB. Point to a file for more.");
    }
    // One send at a time is counted and recorded, so parallel ones can't pass the rate together.
    let one = COUNTING.lock().unwrap_or_else(|e| e.into_inner());
    let now = log::now_ms();
    let turn = core::fold(&core::session_dir(data, me), true).ok();
    let turn = turn.and_then(|f| f.fold.turns.first().map(|t| t.id.clone()));
    let hop = turn.map_or(0, |t| hop_of(data, me, &t)) + 1;
    let recent = (all::<Out>(data, me, "out").iter())
        .filter(|o| o.state != "stopped" && o.at + 60_000 > now)
        .count();
    let why = match () {
        _ if hop > HOPS => Some("hops"),
        _ if recent >= RATE => Some("rate"),
        _ => None,
    };
    let mut out = Out {
        mid: format!("m{}", core::adapters::uuid()[..13].replace('-', "")),
        to: to.into(),
        text: text.into(),
        hop,
        at: now,
        wait: wait.is_some(),
        state: if why.is_some() { "stopped" } else { "written" }.into(),
        why: why.map(String::from),
        reply: None,
    };
    let sending = held::Sending::new(&out.mid);
    if let Err(e) = save(data, me, "out", &out.mid, &out) {
        return refuse(&e.to_string());
    }
    drop(one);
    let phase = if why.is_some() { "stopped" } else { "sent" };
    // To its own worker: the old lead's "Messaged ‹worker›" row, not a peer's [D3010, D3044].
    let worker = workers::link(data, to).is_some_and(|l| l.parent == me);
    // A worker's message to its own parent is a question for it, never in its user's queue [D131].
    let asks = workers::link(data, me).is_some_and(|l| l.parent == to);
    note(
        data,
        me,
        json!({"phase": phase, "mid": out.mid, "to": to, "text": text, "wait": out.wait, "why": why, "worker": worker, "asks": asks}),
    );
    crash_at("sent");
    open(data, me);
    match why {
        Some("hops") => {
            return refuse(
                "Stopped: this exchange between sessions reached 8 hops. It waits for the user, who can send it anyway. Don't send it again.",
            );
        }
        Some(_) => {
            return refuse(
                "Stopped: you sent 20 messages in the last minute. It waits for the user, who can send it anyway. Put the rest in one message.",
            );
        }
        None if let Some(answered) = reply::answered(data, me, &mut out) => return answered,
        None => {}
    }
    if asks {
        return reply::ask(data, me, &mut out, wait.unwrap_or(crate::agent::WAIT), here);
    }
    let how = match held::hand(data, me, &mut out) {
        Ok(how) => how,
        Err(e) => return refuse(&format!("Couldn't send it: {e}")),
    };
    drop(sending);
    let said = match how {
        // As its receiver has it: a pass may have settled the sender's meanwhile.
        "steered" => match held::state(data, to, &out.mid).as_deref() {
            Some("uncertain") => queue::UNSURE.into(),
            // Proposed words.
            Some("steering") => "It went into the turn it's working on. Its agent hasn't confirmed it yet: don't send it again.".into(),
            _ => "It went into the turn it's working on.".into(),
        },
        "dropped" => return refuse(&format!("{to} was deleted.")),
        _ => queue::waits_for(data, me, to, &out.mid, how == "held"),
    };
    let Some(secs) = wait else {
        let text = format!(
            "Sent to {to}. {said} Its answer comes only if it sends you one; add --wait to wait for it."
        );
        return json!({"ok": true, "mid": out.mid, "how": how, "text": text});
    };
    reply::waited(data, me, &out, secs, here)
}

/// Hands a message to its receiver: recorded and judged under its queue lock, a repeat dropped;
/// steered into its running turn, or held till that turn can take it, else queued to start the
/// next. Says how: steered | held | queued | repeat | dropped.
fn hand(data: &Path, from: &str, out: &mut Out) -> io::Result<&'static str> {
    let to = out.to.clone();
    let dir = core::session_dir(data, &to);
    if core::load(data, &to).is_err() {
        settle_out(data, from, out, "dropped", Some("deleted"));
        return Ok("dropped");
    }
    let origin = format!("peer:{from}");
    let body = first::envelope(data, from, out);
    let mid = out.mid.clone();
    let mut rec = In {
        mid: mid.clone(),
        from: from.into(),
        hop: out.hop,
        at: log::now_ms(),
        how: "queue".into(),
        turn: None,
        state: "adding".into(),
    };
    // A switch review's findings start a fix turn of their own, never steered [D3026].
    let steer = workers::link(data, from).is_none_or(|l| l.review["switch"] != true);
    let at = out.at;
    let how = queue::add_peer(&dir, &mid, &origin, &body, |queued| {
        // Never past its sender's earlier one that still waits: held behind it [D67].
        if held::behind(data, from, &to, at, &mid) {
            return held::hold(data, &to, &mut rec);
        }
        let f = core::fold(&dir, true)?.fold;
        let can = adapters::get(&f.backend).is_some_and(|a| a.can().steer);
        // Mid-turn it goes into that turn, past the user's queue and whatever Follow-up says: that
        // queue is the user's own [D118], unless one of its sender's waits there [D67]. A turn that can't take it yet (not begun, waiting on the
        // user, an agent with no steer) holds it for the next pass; a dead host's turn doesn't.
        let alive = owner::state(data, &to) == core::fold::Owner::Alive;
        if let Some(t) = f.turns.first().filter(|_| alive && steer) {
            if queued || !(can && t.began && t.asks.is_empty()) {
                return held::hold(data, &to, &mut rec);
            }
            (rec.how, rec.turn, rec.state) =
                ("steer".into(), Some(t.id.clone()), "steering".into());
            save(data, &to, "in", &mid, &rec)?;
            let reply =
                control::steer_as(data, &to, &body, &Value::Null, Some(&mid), &origin, false)?;
            let logged = core::fold(&dir, true).is_ok_and(|f| f.fold.cids.contains_key(&mid));
            // Written: only its agent's own reply says it took it, and a pass settles it then [D66].
            let state = match reply["result"].as_str() {
                Some("delivered") => Some("delivered"),
                _ if logged => Some("steering"),
                _ => None,
            };
            if let Some(state) = state {
                rec.state = state.into();
                save(data, &to, "in", &mid, &rec)?;
                return Ok(Some("steered"));
            }
            // Its turn ended meanwhile: it starts the next one.
            (rec.how, rec.turn) = ("queue".into(), None);
        }
        // Proposed: a parent's message to its own worker reports back as its brief does.
        if let Some(mut l) = workers::link(data, &to).filter(|l| l.parent == from)
            && !l.report.contains(&mid)
        {
            l.report.push(mid.clone());
            workers::write_json(&dir.join("worker.json"), &l)?;
        }
        rec.state = "adding".into();
        save(data, &to, "in", &mid, &rec).map(|()| None)
    })?;
    if how == "held" {
        return Ok(how);
    }
    if how == "queued" {
        rec.state = "queued".into();
        save(data, &to, "in", &mid, &rec)?;
        crash_at("queued");
    }
    // Already there (a restart cut it short after its queue entry): only its record moves on.
    if how == "repeat" {
        let p = path(data, &to, "in", &mid);
        if let Some(mut was) = workers::read_json::<In>(&p).filter(|r| r.state == "adding") {
            was.state = "queued".into();
            workers::write_json(&p, &was)?;
        }
        settle_out(data, from, out, "sent", None);
        return Ok(how);
    }
    let state = match (how, rec.state.as_str()) {
        ("steered", s) if s != "steering" => s.to_string(),
        _ => "sent".into(),
    };
    note(
        data,
        from,
        json!({"phase": "handed", "mid": mid, "how": how}),
    );
    settle_out(data, from, out, &state, None);
    Ok(how)
}

/// Moves the sender's record on, and its row with it.
fn settle_out(data: &Path, from: &str, out: &mut Out, state: &str, why: Option<&str>) {
    if out.state == state || held::done(data, from, &out.mid) {
        return;
    }
    out.state = state.into();
    if why.is_some() {
        out.why = why.map(String::from);
    }
    let _ = save(data, from, "out", &out.mid.clone(), out);
    if state != "sent" {
        note(
            data,
            from,
            json!({"phase": state, "mid": out.mid, "why": why}),
        );
    }
}

/// `peers <id> send <mid>`, the user's Send anyway [D2034, D3014]: a stopped message goes, past
/// the hop and rate checks, as hop 1, as though the user began the chain (proposed).
pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let (id, mid) = (crate::arg(args, 1)?, crate::arg(args, 3)?);
    if crate::arg(args, 2)? != "send" {
        return Err(io::Error::other(crate::USAGE));
    }
    core::check_id(mid)?;
    let p = path(data, id, "out", mid);
    let Some(mut out) = workers::read_json::<Out>(&p).filter(|o| o.state == "stopped") else {
        return Err(io::Error::other("no stopped message by that id"));
    };
    (out.hop, out.state, out.why, out.at) = (1, "written".into(), None, log::now_ms());
    save(data, id, "out", mid, &out)?;
    note(data, id, json!({"phase": "sent", "mid": mid}));
    open(data, id);
    let how = held::hand(data, id, &mut out)?;
    Ok(json!({"ok": true, "how": how, "at": crate::index::touched(&core::session_dir(data, id))}))
}

/// Senders with a message not yet settled; filled from disk at the daemon's first pass.
static COUNTING: Mutex<()> = Mutex::new(());
static OPEN: Mutex<Option<BTreeSet<String>>> = Mutex::new(None);
/// Senders a pass runs for now.
static PASSING: Mutex<Option<BTreeSet<String>>> = Mutex::new(None);

/// Senders with messages on disk, read once at the daemon's first use.
fn known(data: &Path) -> BTreeSet<String> {
    let ids = core::ids(data).into_iter();
    ids.filter(|id| core::session_dir(data, id).join("peers/out").exists())
        .collect()
}

fn open(data: &Path, id: &str) {
    let mut open = OPEN.lock().unwrap();
    open.get_or_insert_with(|| known(data)).insert(id.into());
    // And for the daemon's own set, when another process opened it: a standalone Recover's [D66].
    let dir = data.join("peers-open");
    let _ = fs::create_dir_all(&dir).and_then(|()| fs::write(dir.join(id), ""));
}

const DONE: [&str; 5] = ["delivered", "uncertain", "dropped", "stopped", "refused"];

/// The daemon's pass: each sender with an open message, off the loop and one at a time.
pub fn pass(data: &Path, rows: &BTreeMap<String, Value>) {
    let senders: Vec<String> = {
        let mut open = OPEN.lock().unwrap();
        let open = open.get_or_insert_with(|| known(data));
        for e in fs::read_dir(data.join("peers-open"))
            .into_iter()
            .flatten()
            .flatten()
        {
            if fs::remove_file(e.path()).is_ok() {
                open.insert(e.file_name().to_string_lossy().into());
            }
        }
        held::recovered(data, open);
        open.retain(|id| rows.contains_key(id));
        open.iter().cloned().collect()
    };
    for id in senders {
        let mut passing = PASSING.lock().unwrap();
        if !passing.get_or_insert_with(BTreeSet::new).insert(id.clone()) {
            continue;
        }
        drop(passing);
        let states: BTreeMap<String, String> = (rows.iter())
            .map(|(k, r)| (k.clone(), r["state"].as_str().unwrap_or("").to_string()))
            .collect();
        let data = data.to_path_buf();
        thread::spawn(move || {
            if let Err(e) = finish::finish(&data, &id, &states) {
                eprintln!("brigadierd: messages from {id}: {e}");
            }
            PASSING.lock().unwrap().as_mut().map(|p| p.remove(&id));
        });
    }
}
