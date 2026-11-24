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
    let job = (left.into_iter()).find(|j| j.under && (j.pid, j.start_us) == (pid, start));
    let tell = || {
        let Some(job) = job else { return };
        let msg = json!({"kind": "stop_task", "task": job.task, "command": job.label});
        let req = json!({"cid": control::new_cid(), "control": msg});
        let sent = control::deliver(data, &spec.id, req, false, |_| Ok(msg.clone()));
        let until = Instant::now() + Duration::from_secs(2);
        while job.task.is_some()
            && sent.as_ref().is_ok_and(|s| s["ok"] == true)
            && procs::same(pid, start).is_some()
            && Instant::now() < until
        {
            std::thread::sleep(Duration::from_millis(50));
        }
    };
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

/// The workers under a session, theirs too; a Brigade's sessions aren't among them [D189].
pub(super) fn family(data: &Path, id: &str) -> Vec<workers::Record> {
    (workers::records(data, id).into_iter())
        .filter(|r| !r.session)
        .flat_map(|r| {
            let below = family(data, &r.wid);
            std::iter::once(r).chain(below)
        })
        .collect()
}

/// Ends what a worker whose turns are over, their results not held for it, left running, a mockup's
/// server too.
pub(crate) fn end(data: &Path, id: &str) -> io::Result<()> {
    let dir = core::session_dir(data, id);
    if !dir.join("session.json").exists() {
        return Ok(());
    }
    let f = core::fold(&dir, true)?.fold;
    let paused = workers::link(data, id).is_some_and(|l| l.paused);
    let cut = !f.turns.is_empty();
    if paused
        || cut && owner::state(data, id) != fold::Owner::Dead
        || workers::unreported(data, id, &f, cut)
    {
        return Ok(());
    }
    let left = fold::live(&f, owner::state(data, id), &dir, &procs::all()).left;
    let left: Vec<_> = left.iter().map(|j| (j.pid, j.start_us)).collect();
    match core::background::end(&dir, &f, Some(&left), || ()) {
        Some(alive) if alive.is_empty() => Ok(()),
        Some(alive) => Err(io::Error::other(format!(
            "process {} didn't stop",
            alive[0].pid
        ))),
        None => Err(io::Error::other("one isn't known to be its own any more")),
    }
}
