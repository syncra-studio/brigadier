//! What a finished worker left running is ended by itself, once its parent has its result and
//! nothing holds it; a mockup's only after the pick. What can't be ended stays on its lead's card.
//! Its agent's process is closed once nothing has run in it for a while: the next message starts it
//! again on the same conversation. Its worktree's build output goes at once.

use crate::owner;
use crate::relay::mockup;
use crate::sessions;
use crate::workers::{busy, link, read_json, result, write_json};
use brigadier_core as core;
use brigadier_frames::{log, procs, take_lock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// `left.json` in the worker's folder.
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Left {
    /// The session whose chat the question that once asked was in, till its answers are read.
    #[serde(skip_serializing)]
    to: Option<String>,
    /// What started before this (ms) the user kept, by the last Keep they answered it.
    kept: u64,
    /// What couldn't be ended, each by pid and start time: not tried again.
    stuck: Vec<(i32, u64)>,
}

impl Left {
    fn leaves(&self, (pid, start): (i32, u64)) -> bool {
        start / 1000 < self.kept || self.stuck.contains(&(pid, start))
    }
}

/// How long a finished worker's agent stays up with nothing in its log: its parent's next message
/// is rarely later, and each holds memory, its MCP servers' too.
const IDLE: Duration = Duration::from_secs(30 * 60);
/// One closes at a time.
static CLOSING: Mutex<()> = Mutex::new(());

/// Ends what its finished worker left running, then, idle, its agent.
pub(super) fn pass(data: &Path, wid: &str, row: &Value) {
    let path = core::session_dir(data, wid).join("left.json");
    let left = read_json::<Left>(&path).unwrap_or_default();
    // The summary card's finished kinds but `paused`, which goes on at Resume.
    let finished = matches!(
        row["worker"]["kind"].as_str(),
        Some("done" | "doneNotMerged" | "merged" | "failed" | "stopped")
    ) && row["running"] != true;
    let mut jobs = (row["background"].as_array().into_iter().flatten())
        .filter_map(|j| Some((j["pid"].as_i64()? as i32, j["start_us"].as_u64()?)));
    if finished && !jobs.all(|j| left.leaves(j)) {
        let (data, wid) = (data.to_path_buf(), wid.to_string());
        std::thread::spawn(move || {
            if let Err(e) = end(&data, &wid, &path) {
                eprintln!("brigadierd: what worker {wid} left running: {e}");
            }
        });
        return;
    }
    let quiet = log::now_ms().saturating_sub(row["updated"].as_u64().unwrap_or(u64::MAX));
    let running = row["background"].as_array().is_some_and(|l| !l.is_empty());
    if finished && !running && row["archived"].is_null() {
        unbuild(data, wid, &row["items"]);
    }
    let idle = finished && row["child"] == true && !running && row["queue"].is_null();
    if idle && quiet >= IDLE.as_millis() as u64 {
        let (data, wid) = (data.to_path_buf(), wid.to_string());
        std::thread::spawn(move || {
            let Ok(_one) = CLOSING.try_lock() else {
                return;
            };
            if let Err(e) = close(&data, &wid) {
                eprintln!("brigadierd: closing worker {wid}'s agent: {e}");
            }
        });
    }
}

/// Takes a finished worker's build output, one worker at a time: once as its log stands, and again
/// in a while as long as something still holds it.
fn unbuild(data: &Path, wid: &str, items: &Value) {
    static BUSY: AtomicBool = AtomicBool::new(false);
    /// When it was looked at, by its log's length then; None: done.
    type Looked = HashMap<String, (Value, Option<Instant>)>;
    static LOOKED: Mutex<Option<Looked>> = Mutex::new(None);
    const AGAIN: Duration = Duration::from_secs(10);
    let mut looked = LOOKED.lock().unwrap();
    let looked = looked.get_or_insert_default();
    let again = match looked.get(wid) {
        Some((i, at)) => i != items || at.is_some_and(|at| at.elapsed() >= AGAIN),
        None => true,
    };
    if !again || BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    looked.insert(wid.into(), (items.clone(), Some(Instant::now())));
    let (data, wid, items) = (data.to_path_buf(), wid.to_string(), items.clone());
    std::thread::spawn(move || {
        match unbuilt(&data, &wid) {
            Ok(false) => {}
            done => {
                if let Err(e) = done {
                    eprintln!("brigadierd: worker {wid}'s build output: {e}");
                }
                let mut looked = LOOKED.lock().unwrap();
                looked.get_or_insert_default().insert(wid, (items, None));
            }
        }
        BUSY.store(false, Ordering::SeqCst);
    });
}

/// Whether nothing is left to take: it's gone, or the worker has none.
fn unbuilt(data: &Path, wid: &str) -> io::Result<bool> {
    let Some(held) = over(data, wid)? else {
        return Ok(false);
    };
    let spec = core::load(data, wid)?;
    if !matches!(core::session::lifecycle(&spec.dir), (None, Value::Null)) {
        return Ok(true);
    }
    let f = core::fold(&spec.dir, true)?.fold;
    let live = core::fold::live(&f, owner::state(data, wid), &spec.dir, &procs::all());
    if (live.jobs, live.left.len(), f.turns.len()) != (0, 0, 0) || busy(data, wid) {
        return Ok(false);
    }
    let built = core::session::built(data, &spec)?;
    if !built.is_empty() {
        // Setup runs as an agent starts: the next message must start it.
        if live.child.is_some() && spec.dir.join("setup.exit").exists() {
            if f.pending.wakes() || !f.agents.is_empty() {
                return Ok(false);
            }
            owner::call(data, wid, json!({"op": "stop", "by": "idle"}))?;
        }
        core::session::unbuild(&spec, &built)?;
    }
    drop(held);
    core::session::unbuilt(&spec.dir).map(|()| true)
}

/// Closes a finished worker's idle agent, its host kept: nothing runs in it or will wake it.
fn close(data: &Path, wid: &str) -> io::Result<()> {
    let Some(_held) = over(data, wid)? else {
        return Ok(());
    };
    let dir = core::session_dir(data, wid);
    let f = core::fold(&dir, true)?.fold;
    let live = core::fold::live(&f, owner::state(data, wid), &dir, &procs::all());
    let quiet = fs::metadata(dir.join("log"))?.modified()?.elapsed();
    let wakes = f.pending.wakes() || !f.agents.is_empty();
    if live.child.is_none()
        || (live.jobs, live.left.len()) != (0, 0)
        || !f.turns.is_empty()
        || wakes
        || busy(data, wid)
        || quiet.is_ok_and(|q| q < IDLE)
    {
        return Ok(());
    }
    owner::call(data, wid, json!({"op": "stop", "by": "idle"})).map(|_| ())
}

/// A worker that's over, judged under the locks a send takes, in its order, while they're held: no
/// turn starts meanwhile. None: something still holds it.
fn over(data: &Path, wid: &str) -> io::Result<Option<(File, File)>> {
    let dir = core::session_dir(data, wid);
    let Some(queue) = take_lock(&dir.join("queue.lock"))? else {
        return Ok(None);
    };
    let fence = core::worktrees::lock(&dir)?;
    let Some(l) = link(data, wid).filter(|l| !l.session && !l.paused) else {
        return Ok(None);
    };
    // Until the pick the user may still compare a mockup's variants.
    let comparing = mockup::state(data, wid).is_some_and(|m| m["picked"].is_null());
    if comparing || !result::told(data, &l.parent, wid, &l) {
        return Ok(None);
    }
    // Written isn't in: a parent at work or waiting on the user takes it after. A held one is.
    let coming = |r: &result::Res| {
        r.wid == wid && r.how != "asks" && matches!(r.state.as_str(), "written" | "sent")
    };
    let on = (result::all(data, &l.parent).iter()).any(|(_, r)| coming(r));
    Ok((!on).then_some((queue, fence)))
}

/// Ends what a worker that's over left running.
fn end(data: &Path, wid: &str, path: &Path) -> io::Result<()> {
    let Some(_held) = over(data, wid)? else {
        return Ok(());
    };
    let mut left = read_json::<Left>(path).unwrap_or_default();
    if let Some(to) = left.to.take() {
        left.kept = kept(data, wid, &to)?;
        write_json(path, &left)?;
    }
    let stuck = sessions::end_jobs(data, wid, |j| left.leaves(j))?;
    if !stuck.is_empty() {
        left.stuck.extend(stuck);
        write_json(path, &left)?;
    }
    Ok(())
}

/// When the user last answered Keep on what `wid` left, in `to`'s chat (ms); 0 for never.
fn kept(data: &Path, wid: &str, to: &str) -> io::Result<u64> {
    let mut kept = 0;
    let of = |id: &Value| id.as_str().and_then(|i| i.splitn(3, '-').nth(2)) == Some(wid);
    core::read(&core::session_dir(data, to), |i| {
        if i["event"] == "left" && i["choice"] == "Keep" && of(&i["id"]) {
            kept = i["ts"].as_u64().unwrap_or(0);
        }
    })?;
    Ok(kept)
}
