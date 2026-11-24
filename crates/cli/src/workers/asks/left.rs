//! What a finished worker left running is ended by itself, once its parent has its result and
//! nothing holds it; a mockup's only after the pick. What can't be ended stays on its lead's card.

use crate::relay::mockup;
use crate::sessions;
use crate::workers::{link, read_json, result, write_json};
use brigadier_core as core;
use brigadier_frames::take_lock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io;
use std::path::Path;

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

/// Ends what its finished worker left running.
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
    }
}

/// Judged again under the locks a send takes, in its order: no turn starts between that and the kill.
fn end(data: &Path, wid: &str, path: &Path) -> io::Result<()> {
    let dir = core::session_dir(data, wid);
    let Some(_queue) = take_lock(&dir.join("queue.lock"))? else {
        return Ok(());
    };
    let _fence = core::worktrees::lock(&dir)?;
    let Some(l) = link(data, wid).filter(|l| !l.session) else {
        return Ok(());
    };
    // Until the pick the user may still compare a mockup's variants.
    let comparing = mockup::state(data, wid).is_some_and(|m| m["picked"].is_null());
    if comparing || !result::told(data, &l.parent, wid, &l) {
        return Ok(());
    }
    // Written isn't in: a parent at work or waiting on the user takes it after. A held one is.
    let coming = |r: &result::Res| {
        r.wid == wid && r.how != "asks" && matches!(r.state.as_str(), "written" | "sent")
    };
    if (result::all(data, &l.parent).iter()).any(|(_, r)| coming(r)) {
        return Ok(());
    }
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
