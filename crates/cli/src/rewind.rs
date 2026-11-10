//! `rewind <id> <cid> --preview [--files] | --op OP [--restore]` [D384]: what the app calls, and the two
//! passes that keep it honest. Takes the queue's lock, then core's fence, through to the end.

use crate::{arg, flag, has, owner, queue};
use brigadier_core::fold::{self, Owner};
use brigadier_core::{self as core, Spec, check_id};
use brigadier_frames::{log, procs, take_lock};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::Path;
use std::thread;

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let (id, cid) = (arg(args, 1)?, arg(args, 2)?);
    let spec = core::load(data, id)?;
    check_id(cid)?;
    settled(data, &spec)?;
    if has(args, "--preview") {
        let f = core::fold(&spec.dir, true)?.fold;
        return Ok(core::rewind::preview(
            data,
            &spec,
            &f,
            cid,
            has(args, "--files"),
        ));
    }
    let op = flag(args, "--op").ok_or_else(|| io::Error::other(crate::USAGE))?;
    check_id(op)?;
    owner::ensure(data, &spec)?;
    let (_queue, waiting) = queue::hold(&spec.dir)?;
    if waiting {
        return Ok(json!({"ok": false, "error": "queued",
            "message": "Messages are waiting to send. Send or remove them first."}));
    }
    let call = |req| owner::call(data, id, req);
    let live = |f: &fold::Fold| fold::live(f, owner::state(data, id), data, &procs::all());
    let restore = has(args, "--restore");
    core::rewind::apply(data, &spec, op, cid, restore, &call, &live)
}

/// Before anything else runs in a session: a rewind cut short finishes or rolls back.
pub fn settled(data: &Path, spec: &Spec) -> io::Result<()> {
    if core::rewind::pending(&spec.dir) {
        let _queue = queue::hold(&spec.dir)?;
        settle_held(data, spec)?;
    }
    Ok(())
}

/// The same, for a caller that holds the queue's lock.
pub fn settle_held(data: &Path, spec: &Spec) -> io::Result<()> {
    if core::rewind::pending(&spec.dir) {
        owner::ensure(data, spec)?;
        let call = |req| owner::call(data, &spec.id, req);
        core::rewind::settle(spec, &call)?;
    }
    Ok(())
}

/// At the daemon's start, once: no client may be back before a crash is cleared up.
pub fn sweep(data: &Path) {
    for id in core::rewind::cut_short(data) {
        if let Err(e) = core::load(data, &id).and_then(|s| settled(data, &s)) {
            eprintln!("brigadierd: rewind {id}: {e}");
        }
    }
}

/// The daemon's pass: a turn that just ended has its folder taken now, before another is let in
/// and before the user can have touched it. Off the loop, under the same locks a send takes.
pub fn ends(data: &Path, rows: &BTreeMap<String, Value>, seen: &mut HashMap<String, u64>) {
    for (id, row) in rows {
        let at = row["finished"].as_u64().unwrap_or(0);
        if seen.insert(id.clone(), at).is_some_and(|old| old == at)
            || row["running"] == true
            || log::now_ms().saturating_sub(at) > core::rewind::GRACE_MS
        {
            continue;
        }
        let (data, id) = (data.to_path_buf(), id.clone());
        thread::spawn(move || {
            let dir = core::session_dir(&data, &id);
            let Ok(Some(_queue)) = take_lock(&dir.join("queue.lock")) else {
                return;
            };
            let Ok(_fence) = core::worktrees::lock(&dir) else {
                return;
            };
            if let (Ok(spec), Ok(f), false) = (
                core::load(&data, &id),
                core::fold(&dir, true),
                owner::state(&data, &id) == Owner::Dead,
            ) {
                core::rewind::ends(&spec, &f.fold);
            }
        });
    }
}
