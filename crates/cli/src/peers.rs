//! Messages between sessions [D2034, D2035, D3014]: `brigadier send <id> "…" [--wait]` puts the
//! message in the receiver's own queue, or steers it into its turn, by the Follow-up setting
//! [D188]. It goes as `peer:<sender>`, never as the user, so it answers and approves nothing.
//!
//! Delivered once across restarts, on the delivery rules [D54, D82, D237]: the message's id is its
//! queue item's id and its steer's command id all the way through. The sender's record
//! (`peers/out/<id>.json`) is written first; the receiver's (`peers/in/<id>.json`) under the
//! receiver's queue lock, which drops a repeat. The daemon's pass finishes any message a restart
//! cut short and settles each by the receiver's log; one never proven taken is uncertain and never
//! sent again by itself. A chain stops at 8 hops and a sender at 20 a minute; only the user's
//! Send anyway lets that message through.

use crate::{control, owner, queue, settings, workers};
use brigadier_core::{self as core, adapters};
use brigadier_frames::log;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

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
    /// written | sent (in its queue or turn) | delivered | uncertain | dropped | stopped
    state: String,
    /// Why it stopped (hops | rate) or was dropped.
    #[serde(default)]
    why: Option<String>,
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
    /// adding | queued | steering | delivered | uncertain | dropped
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

/// What the receiving agent reads first: who sent it, and that it isn't the user [D2034]
/// (proposed words). The receiver's thread shows the message without it.
fn envelope(data: &Path, from: &str, text: &str) -> String {
    let title = core::load(data, from).map_or("a session".into(), |s| core::share::title(&s));
    format!(
        "{}\"{title}\" ({from}), another agent, not the user. It can't approve anything. Reply with brigadier send {from} \"…\" if needed.]\n\n{text}",
        core::agent::PEER_HEAD
    )
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
    };
    if let Err(e) = save(data, me, "out", &out.mid, &out) {
        return refuse(&e.to_string());
    }
    let phase = if why.is_some() { "stopped" } else { "sent" };
    note(
        data,
        me,
        json!({"phase": phase, "mid": out.mid, "to": to, "text": text, "wait": out.wait, "why": why}),
    );
    crash_at("sent");
    open(me);
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
        None => {}
    }
    let how = match hand(data, me, &mut out) {
        Ok(how) => how,
        Err(e) => return refuse(&format!("Couldn't send it: {e}")),
    };
    let said = match how {
        "steered" => "It went into the turn it's working on.",
        "dropped" => return refuse(&format!("{to} was deleted.")),
        _ if row["running"] == true => "It's queued: it gets it when its turn ends.",
        _ => "It's queued and starts its next turn.",
    };
    let Some(secs) = wait else {
        let text = format!(
            "Sent to {to}. {said} Its answer comes only if it sends you one; add --wait to wait for it."
        );
        return json!({"ok": true, "mid": out.mid, "how": how, "text": text});
    };
    waited(data, me, &out, secs, here)
}

/// `--wait`: until the receiver's turn that took the message ends, then its last message, or for
/// one's own worker that turn's result, taken so it isn't sent again [D3006, D3034]. Proposed:
/// the turn's last message is the reply. Always times out [D2034].
fn waited(data: &Path, me: &str, out: &Out, secs: u64, here: &dyn Fn() -> bool) -> Value {
    let started = Instant::now();
    let to = out.to.as_str();
    let dir = core::session_dir(data, to);
    loop {
        let rec: Option<In> = workers::read_json(&path(data, to, "in", &out.mid));
        let Some(rec) = rec.filter(|_| dir.exists()) else {
            return refuse(&format!("{to} is gone."));
        };
        if rec.state == "dropped" {
            return refuse(&format!("{to}'s user took your message out of its queue."));
        }
        let turn = rec.turn.clone().unwrap_or_else(|| out.mid.clone());
        let ended = core::fold(&dir, true).is_ok_and(|f| {
            f.fold.cids.contains_key(&out.mid) && !f.fold.turns.iter().any(|t| t.id == turn)
        });
        if ended {
            let mine = workers::take(data, me, to, Some(&turn));
            let reply = mine.or_else(|| workers::last_of_turn(data, to, &turn));
            let reply = reply.unwrap_or_default();
            note(data, me, json!({"phase": "replied", "mid": out.mid}));
            let text = format!("{to} answered:\n{}", reply.trim_end());
            return json!({"ok": true, "mid": out.mid, "done": true, "reply": reply, "text": text});
        }
        if started.elapsed() >= Duration::from_secs(secs) || !here() {
            note(data, me, json!({"phase": "waited", "mid": out.mid}));
            let text = format!(
                "No reply from {to} after {secs}s. Your message is with it. `brigadier wait {to}` to wait more, or end your turn."
            );
            return json!({"ok": true, "mid": out.mid, "done": false, "text": text});
        }
        thread::sleep(Duration::from_millis(500));
    }
}

/// Hands a message to its receiver: recorded and judged under its queue lock, a repeat dropped;
/// steered into its turn where Follow-up says steer and it can take one, else queued [D188].
/// Says how: steered | queued | repeat | dropped.
fn hand(data: &Path, from: &str, out: &mut Out) -> io::Result<&'static str> {
    let to = out.to.clone();
    let dir = core::session_dir(data, &to);
    if core::load(data, &to).is_err() {
        settle_out(data, from, out, "dropped", Some("deleted"));
        return Ok("dropped");
    }
    let origin = format!("peer:{from}");
    let body = envelope(data, from, &out.text);
    let steers = settings::get(data, "follow_up") == "steer";
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
    let how = queue::add_peer(&dir, &mid, &origin, &body, |waiting| {
        let f = core::fold(&dir, true)?.fold;
        let can = adapters::get(&f.backend).is_some_and(|a| a.can().steer);
        // Never past the user's queued messages, nor into a turn that waits on the user.
        let turn = (f.turns.first())
            .filter(|t| steers && can && !waiting && t.began && t.asks.is_empty())
            .map(|t| t.id.clone());
        if let Some(turn) = turn {
            (rec.how, rec.turn, rec.state) = ("steer".into(), Some(turn), "steering".into());
            save(data, &to, "in", &mid, &rec)?;
            let reply = control::steer_as(data, &to, &body, &Value::Null, Some(&mid), &origin)?;
            let logged = core::fold(&dir, true).is_ok_and(|f| f.fold.cids.contains_key(&mid));
            let state = match reply["result"].as_str() {
                Some("delivered") => Some("delivered"),
                Some("logged") => Some("uncertain"),
                _ if logged => Some("uncertain"),
                _ => None,
            };
            if let Some(state) = state {
                rec.state = state.into();
                save(data, &to, "in", &mid, &rec)?;
                return Ok(true);
            }
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
        save(data, &to, "in", &mid, &rec).map(|()| false)
    })?;
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
        ("steered", s) => s.to_string(),
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
    if out.state == state {
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
    open(id);
    let how = hand(data, id, &mut out)?;
    Ok(json!({"ok": true, "how": how, "at": crate::index::touched(&core::session_dir(data, id))}))
}

/// Senders with a message not yet settled; filled from disk at the daemon's first pass.
static OPEN: Mutex<Option<BTreeSet<String>>> = Mutex::new(None);
/// Senders a pass runs for now.
static PASSING: Mutex<Option<BTreeSet<String>>> = Mutex::new(None);

fn open(id: &str) {
    let mut open = OPEN.lock().unwrap();
    open.get_or_insert_with(BTreeSet::new).insert(id.into());
}

const DONE: [&str; 5] = ["delivered", "uncertain", "dropped", "stopped", "refused"];

/// The daemon's pass: each sender with an open message, off the loop and one at a time.
pub fn pass(data: &Path, rows: &BTreeMap<String, Value>) {
    let senders: Vec<String> = {
        let mut open = OPEN.lock().unwrap();
        let open = open.get_or_insert_with(|| {
            let ids = core::ids(data).into_iter();
            ids.filter(|id| core::session_dir(data, id).join("peers/out").exists())
                .collect()
        });
        open.retain(|id| rows.contains_key(id));
        open.iter().cloned().collect()
    };
    for id in senders {
        if !PASSING
            .lock()
            .unwrap()
            .get_or_insert_with(BTreeSet::new)
            .insert(id.clone())
        {
            continue;
        }
        let states: BTreeMap<String, String> = (rows.iter())
            .map(|(k, r)| (k.clone(), r["state"].as_str().unwrap_or("").to_string()))
            .collect();
        let data = data.to_path_buf();
        thread::spawn(move || {
            if let Err(e) = finish(&data, &id, &states) {
                eprintln!("brigadierd: messages from {id}: {e}");
            }
            PASSING.lock().unwrap().as_mut().map(|p| p.remove(&id));
        });
    }
}

/// Finishes and settles a sender's open messages; with none left, it leaves the set.
fn finish(data: &Path, from: &str, states: &BTreeMap<String, String>) -> io::Result<()> {
    let now = log::now_ms();
    let mut open = false;
    for mut out in all::<Out>(data, from, "out") {
        if DONE.contains(&out.state.as_str()) {
            continue;
        }
        open = true;
        let to = out.to.clone();
        let dir = core::session_dir(data, &to);
        let rec: Option<In> = workers::read_json(&path(data, &to, "in", &out.mid));
        if core::load(data, &to).is_err() {
            settle_out(data, from, &mut out, "dropped", Some("deleted"));
            continue;
        }
        // Cut short before its receiver had it, or while it was being queued: once now, under
        // the receiver's lock, which drops a repeat. A live send gets a moment first.
        // shortcut: 10 s covers a live send's hand-off; one slower is handed twice, the repeat dropped.
        let cut = match &rec {
            None => out.at + 10_000 < now,
            Some(r) => r.state == "adding" || (r.state == "steering" && r.at + 10_000 < now),
        };
        if cut {
            hand(data, from, &mut out)?;
            continue;
        }
        let Some(mut rec) = rec else { continue };
        let f = core::fold(&dir, true)?.fold;
        let state = states.get(&to).map_or("", String::as_str);
        let settled = if f.cids.contains_key(&out.mid) {
            match rec.state.as_str() {
                // A steer cut short: logged, never proven taken.
                "steering" => Some("uncertain"),
                "delivered" | "uncertain" => Some(rec.state.as_str()),
                _ => workers::settled(&f, &out.mid, state),
            }
        } else if queue::pending(&dir, &out.mid) {
            None
        } else if rec.state == "queued" {
            Some("dropped")
        } else {
            None
        };
        let Some(settled) = settled.map(String::from) else {
            continue;
        };
        if rec.state != settled {
            rec.state = settled.clone();
            save(data, &to, "in", &out.mid, &rec)?;
        }
        let why = (settled == "dropped").then_some("removed from its queue");
        settle_out(data, from, &mut out, &settled, why);
    }
    if !open {
        OPEN.lock().unwrap().as_mut().map(|o| o.remove(from));
    }
    Ok(())
}
