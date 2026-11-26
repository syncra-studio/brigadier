//! A worker's result delivered into its parent: once, between the parent's turns, settled by
//! the parent's log [D3006, D54, D82].

use super::take::said;
use super::{OPEN, Res, all, fresh, known, told, unsent};
use crate::workers::{closing, read_json, write_json};
use crate::{owner, queue};
use brigadier_core::fold::{self, Owner};
use brigadier_core::{self as core};
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::thread;

/// The states a parent takes a result in: between turns, as the queue's.
const TAKES: [&str; 4] = ["idle", "idle_jobs", "stopped", "failed"];

/// Parents a delivery runs for now.
static SENDING: Mutex<Option<BTreeSet<String>>> = Mutex::new(None);

/// The daemon's pass: each parent with an open result, between turns, gets its oldest one, off
/// the loop and one at a time.
pub fn deliver(data: &Path, rows: &BTreeMap<String, Value>) {
    let parents: Vec<String> = {
        let mut open = OPEN.lock().unwrap();
        let open = open.get_or_insert_with(|| known(data));
        open.retain(|p| rows.contains_key(p));
        open.iter().cloned().collect()
    };
    for pid in parents {
        let row = &rows[&pid];
        let takes = TAKES.contains(&row["state"].as_str().unwrap_or(""));
        let archived = !matches!(row["archived"], Value::Null | Value::Bool(false));
        if archived || (!takes && row["running"] == true && !has_sent(data, &pid)) {
            continue;
        }
        {
            let mut sending = SENDING.lock().unwrap();
            if !sending
                .get_or_insert_with(BTreeSet::new)
                .insert(pid.clone())
            {
                continue;
            }
        }
        let (data, pid, state) = (data.to_path_buf(), pid.clone(), row["state"].clone());
        let finished = row["finished"].as_u64().unwrap_or(0);
        thread::spawn(move || {
            if let Err(e) = settle(&data, &pid, state.as_str().unwrap_or(""), finished) {
                eprintln!("brigadierd: worker result for {pid}: {e}");
            }
            SENDING.lock().unwrap().as_mut().map(|s| s.remove(&pid));
        });
    }
}

fn has_sent(data: &Path, pid: &str) -> bool {
    all(data, pid).iter().any(|(_, r)| r.state == "sent")
}

/// How an input logged under `id` came out, by the session's fold and state; none while open.
pub(crate) fn settled(f: &fold::Fold, id: &str, state: &str) -> Option<&'static str> {
    let turn = f.turns.iter().find(|t| t.id == id);
    let last = f.last.as_ref().filter(|l| l["id"] == id);
    Some(match (turn, last) {
        (Some(t), _) if t.delivered.is_some() => "delivered",
        // The agent may have taken it or not: shown, never sent again by itself [D54, D82].
        (Some(_), _) if matches!(state, "uncertain" | "undelivered") => "uncertain",
        // The turn before it was cut off: one that carries that on is `state` a moment behind.
        (Some(t), _) if state == "interrupted" && f.turns[0].id != t.id => "uncertain",
        (Some(_), _) => return None,
        (None, Some(l)) if l["delivered"] == true => "delivered",
        (None, Some(_)) => "uncertain",
        // shortcut: its turn ended and a later one followed, so the fold no longer holds it;
        // it counts as delivered. Upgrade when the fold keeps each turn's delivery.
        (None, None) => "delivered",
    })
}

/// Moves a parent's results on: a sent one settles by the parent's log, then the oldest written
/// one is sent. A parent with none left open leaves the set.
fn settle(data: &Path, pid: &str, state: &str, finished: u64) -> io::Result<()> {
    let mut results = all(data, pid);
    // A stopped worker's result goes once a turn of the parent's ends after it [D314].
    let due = |r: &Res| r.state == "held" && !r.ended && r.at < finished;
    for (path, r) in results.iter_mut().filter(|(_, r)| due(r)) {
        r.state = "written".into();
        write_json(path, r)?;
    }
    // Only held ones: kept open, not folded, while the parent idles.
    let any = |s: &str| results.iter().any(|(_, r)| r.state == s);
    let held = any("held");
    if held && !any("written") && !any("sent") {
        return Ok(());
    }
    let dir = core::session_dir(data, pid);
    if closing(data, pid) {
        for (path, mut r) in results.into_iter().filter(|(_, r)| r.state == "written") {
            r.state = "dropped".into();
            write_json(&path, &r)?;
        }
        return Ok(());
    }
    let f = core::fold(&dir, true)?.fold;
    for (path, mut r) in results.iter().filter(|(_, r)| r.state == "sent").cloned() {
        let Some(state) = settled(&f, &r.id, state) else {
            continue;
        };
        r.state = state.into();
        write_json(&path, &r)?;
    }
    let proving = unsent::proved(data, pid, &f, state)?;
    // A worker's ask answered or gone before it went isn't sent [D131].
    for (path, mut r) in all(data, pid)
        .into_iter()
        .filter(|(_, r)| r.state == "written" && !fresh(data, r))
    {
        r.state = "dropped".into();
        write_json(&path, &r)?;
    }
    let next = all(data, pid)
        .into_iter()
        .find(|(_, r)| r.state == "written");
    let Some((path, mut r)) = next else {
        if !held && !proving && !all(data, pid).iter().any(|(_, r)| r.state == "sent") {
            OPEN.lock().unwrap().as_mut().map(|o| o.remove(pid));
        }
        return Ok(());
    };
    if !TAKES.contains(&state) {
        return Ok(());
    }
    // Under the parent's queue lock: the user's queued messages go first; those that can't go now
    // don't hold a block this result's worker holds open, which it carries on [D521].
    let (_lock, waiting) = queue::hold(&dir)?;
    let ended = core::fold(&dir, true)?.fold.finished;
    // A wait may have taken it since it was read.
    if (waiting && (!crate::workers::holding(data, pid) || queue::takes(&dir, Some(ended))))
        || read_json::<Res>(&path).is_none_or(|now| now.state != "written")
    {
        return Ok(());
    }
    if core::fold(&dir, true)?.fold.cids.contains_key(&r.id) {
        r.state = "sent".into();
        return write_json(&path, &r);
    }
    let spec = core::load(data, pid)?;
    if unsent::waits(&spec, &core::fold(&dir, true)?.fold, &r) {
        return Ok(());
    }
    crate::rewind::settle_held(data, &spec)?;
    owner::ensure(data, &spec)?;
    let ping = owner::call(data, pid, json!({"op": "ping"}))?;
    let Some(len) = ping["len"].as_u64() else {
        return Ok(());
    };
    let f = core::fold(&dir, true)?;
    let live = fold::live(&f.fold, owner::state(data, pid), &dir, &procs::all());
    let status = fold::status(&f.fold, &live);
    let state = status["state"].as_str().unwrap_or("");
    // A parent the user stopped (or paused) isn't woken: its results go after the next message
    // or Resume [D95].
    if live.owner != Owner::Alive || !TAKES.contains(&state) || fold::resumable(&f.fold, state) {
        return Ok(());
    }
    let child = ping["child"]
        .as_i64()
        .map(|_| ping["spawn"].as_u64().unwrap_or(0));
    let call = |mut req: Value| {
        if req["if_len"].is_null() && matches!(req["op"].as_str(), Some("input" | "spawn")) {
            req["if_len"] = len.into();
        }
        owner::call(data, pid, req)
    };
    let origin = format!("result:{}", said(data, pid, &r));
    // What the user told its workers meanwhile goes first, as it came first [D303].
    let mut notes = String::new();
    told::with(data, pid, &r.id, &mut notes);
    let text = match notes.is_empty() {
        true => r.text.clone(),
        false => format!("{}\n\n{}", notes.trim_start(), r.text),
    };
    let reply =
        crate::workers::make::say_result(&spec, &f.fold, child, &call, &r.id, &origin, &text);
    unsent::after(data, pid, &spec, &path, r, &reply)
}
