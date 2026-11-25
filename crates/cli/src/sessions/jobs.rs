//! What a session's turns left running, stopped alone or with its worker's end [D105].

use crate::{control, owner, workers};
use brigadier_core::{self as core, fold, fold::Fold};
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

/// Stops one process tree proven the session's; its agent hears first, through its CLI's own channel
/// or its adapter's note: else it reads an unexplained kill and may wake to start it again [D117].
/// One out of its agent's tree it doesn't follow.
pub(super) fn stop(
    data: &Path,
    spec: &core::Spec,
    f: &Fold,
    pid: i32,
    start: u64,
) -> io::Result<Value> {
    // One already gone is stopped.
    if procs::same(pid, start).is_none() {
        return Ok(json!({"ok": true}));
    }
    let left = fold::live(f, fold::Owner::Alive, &spec.dir, &procs::all()).left;
    let job = (left.iter()).find(|j| (j.pid, j.start_us) == (pid, start));
    let tell = || tell(data, &spec.id, job);
    let why = match core::background::end(&spec.dir, f, Some(&[(pid, start)]), tell) {
        Some(alive) if alive.is_empty() => {
            fold::note_stop(&spec.dir, pid, start);
            return Ok(json!({"ok": true}));
        }
        Some(alive) => format!("process {} is still running.", alive[0].pid),
        None => "it's running, but isn't known to be this session's.".into(),
    };
    Err(io::Error::other(why))
}

/// Tells the live agent of those under it, through its CLI's own channel, and waits till it ends them.
fn tell<'a>(data: &Path, id: &str, jobs: impl IntoIterator<Item = &'a fold::Job>) {
    for job in jobs.into_iter().filter(|j| j.under) {
        let msg = json!({"kind": "stop_task", "task": job.task, "command": job.label});
        let req = json!({"cid": control::new_cid(), "control": msg});
        let sent = control::deliver(data, id, req, false, |_| Ok(msg.clone()));
        let until = Instant::now() + Duration::from_secs(2);
        while job.task.is_some()
            && sent.as_ref().is_ok_and(|s| s["ok"] == true)
            && procs::same(job.pid, job.start_us).is_some()
            && Instant::now() < until
        {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

/// Ends what a worker whose turns are over, their results not held for it, left running, a mockup's
/// server too, but what it `leaves`. Those that couldn't be ended.
pub(crate) fn end(
    data: &Path,
    id: &str,
    leaves: impl Fn((i32, u64)) -> bool,
) -> io::Result<Vec<(i32, u64)>> {
    let dir = core::session_dir(data, id);
    if !dir.join("session.json").exists() {
        return Ok(vec![]);
    }
    // Read first: what a turn starts after it's judged over isn't in it.
    let all = procs::all();
    let f = core::fold(&dir, true)?.fold;
    let paused = workers::link(data, id).is_some_and(|l| l.paused);
    let cut = !f.turns.is_empty();
    let works = match cut {
        true => owner::state(data, id) != fold::Owner::Dead,
        false => workers::busy(data, id),
    };
    if paused || works {
        return Ok(vec![]);
    }
    let mut left = fold::live(&f, owner::state(data, id), &dir, &all).left;
    left.retain(|j| !leaves((j.pid, j.start_us)));
    let roots: Vec<_> = left.iter().map(|j| (j.pid, j.start_us)).collect();
    core::background::end(&dir, &f, Some(&roots), || tell(data, id, &left));
    Ok((roots.into_iter())
        .filter(|r| procs::same(r.0, r.1).is_some())
        .collect())
}
