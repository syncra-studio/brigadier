//! A chat's finished workers go with its archive, at any depth, and come back with its restore: each
//! archived as the chat is, marked as gone with it, so no list shows it as a chat archived. One at
//! work then goes when it finishes; what a crash cut short goes on at the daemon's start.

use super::{stop, unarchived};
use crate::workers;
use brigadier_core::{self as core, session, session::Guard};
use brigadier_frames::procs;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

/// The archived session above worker `wid` that is nearest, and the family's topmost; None for one
/// under none.
pub(super) fn lead(data: &Path, wid: &str) -> Option<(String, String)> {
    let (mut at, mut near, mut top) = (wid.to_string(), None, None);
    while let Some(l) = workers::link(data, &at) {
        at = l.parent;
        if session::lifecycle(&core::session_dir(data, &at))
            .0
            .is_some()
        {
            near.get_or_insert(at.clone());
            top = Some(at.clone());
        }
    }
    near.zip(top)
}

/// The workers below `id` an archive takes: made, in no archive, restore or delete, not at work.
pub(super) fn finished(data: &Path, id: &str, all: &[procs::Proc]) -> Vec<String> {
    (workers::below(data, id).into_iter())
        .filter(|r| r.state != "starting" && unarchived(&core::session_dir(data, &r.wid)))
        .map(|r| r.wid)
        .filter(|w| !workers::at_work(data, w, all))
        .collect()
}

/// Where `id`'s archive keeps the workers whose losses its confirm named, till they are archived:
/// a daemon cut short before them still frees them as asked.
fn named_at(data: &Path, id: &str) -> PathBuf {
    core::session_dir(data, id).join("archive-named.json")
}

/// Records whose losses `id`'s archive confirm named; none given (no confirm), those done now.
pub(super) fn name(data: &Path, id: &str, named: Option<Vec<String>>) -> io::Result<()> {
    let named = named.unwrap_or_else(|| finished(data, id, &procs::all()));
    fs::write(named_at(data, id), serde_json::to_vec(&named)?)
}

/// Archives `id`'s finished workers, then drops what they kept of it. Those that failed, with why.
/// The caller holds `id`'s family lock.
pub(super) fn archive(data: &Path, id: &str, new: bool) -> Vec<String> {
    let mut stayed = vec![];
    let record = named_at(data, id);
    // A torn record names none: each then keeps what it would lose.
    let named: Vec<String> = (fs::read(&record).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let all = procs::all();
    let gone = finished(data, id, &all);
    // Each before the one its folder is based on the branch of.
    for wid in gone.iter().rev() {
        // Its confirm named what it loses; one done since, or later, was never asked about.
        let guard = match named.contains(wid) {
            true => Guard::Named,
            false => Guard::Lossless,
        };
        if let Err(e) = one(data, wid, guard) {
            let dir = core::session_dir(data, wid);
            let title =
                core::load(data, wid).map_or(dir.display().to_string(), |s| core::share::title(&s));
            stayed.push(format!("{title}: {e}"));
        }
    }
    // What a guard kept, or a folder based on their branch held: of those archived before, later.
    let below = match new {
        true => vec![],
        false => workers::below(data, id),
    };
    let below = below.into_iter().rev().map(|r| r.wid);
    for at in below.chain([id.to_string()]) {
        if let Ok(spec) = core::load(data, &at)
            && session::lifecycle(&spec.dir).0.is_some()
            && session::left(data, &spec)
            && let Err(e) = session::tidy(&spec)
        {
            eprintln!("brigadierd: archived {at}: {e}");
        }
    }
    let _ = fs::remove_file(&record);
    stayed
}

/// One worker's archive, unless it's at work again.
fn one(data: &Path, wid: &str, guard: Guard) -> io::Result<()> {
    let spec = core::load(data, wid)?;
    crate::agent::new::settle(data, wid)?;
    crate::rewind::settled(data, &spec)?;
    core::git::recover::settled(data, wid)?;
    match session::archive(&spec, true, guard, || stop_idle(data, wid)) {
        Err(_) if workers::at_work(data, wid, &procs::all()) => Ok(()),
        done => done,
    }
}

/// A worker's stop, unless it's at work: under its lock, so no turn starts after the look.
fn stop_idle(data: &Path, wid: &str) -> io::Result<()> {
    match workers::at_work(data, wid, &procs::all()) {
        true => Err(io::Error::other("it's at work")),
        false => stop(data, wid, "archive"),
    }
}

/// Restores `spec`'s session and the workers that went with it; those that couldn't be, with why.
pub(super) fn restore(data: &Path, spec: &core::Spec) -> io::Result<Vec<String>> {
    let _family = workers::family_lock(data, &spec.id)?;
    session::restore(data, spec)?;
    let mut failed = vec![];
    let mut under = vec![spec.id.clone()];
    while let Some(id) = under.pop() {
        for r in workers::records(data, &id) {
            let dir = core::session_dir(data, &r.wid);
            let archived = session::lifecycle(&dir).0.is_some();
            // One archived by itself before stays, and what went with that.
            if archived && !session::went_with(&dir) {
                continue;
            }
            if archived
                && let Err(e) = core::load(data, &r.wid).and_then(|s| session::restore(data, &s))
            {
                failed.push(format!("{}: {e}", r.title));
                continue;
            }
            under.push(r.wid);
        }
    }
    Ok(failed)
}

/// The daemon's pass: a worker that finished under a chat archived meanwhile goes too. Tried once
/// as its log stands; the daemon's next start tries again.
pub(crate) fn pass(data: &Path, wid: &str, row: &Value) {
    static TRIED: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);
    if row["running"] == true || !unarchived(&core::session_dir(data, wid)) {
        return;
    }
    let Some((_, root)) = lead(data, wid) else {
        return;
    };
    let seen = (TRIED.lock().unwrap())
        .get_or_insert_with(HashMap::new)
        .insert(wid.into(), row["items"].clone());
    if seen.as_ref() == Some(&row["items"]) {
        return;
    }
    let data = data.to_path_buf();
    std::thread::spawn(move || again(&data, &root));
}

/// Free up space's: what its archive, or its chat's, left of `id`.
pub(crate) fn again_of(data: &Path, id: &str) -> io::Result<()> {
    let spec = core::load(data, id)?;
    let Some((_, root)) = lead(data, id) else {
        return session::tidy(&spec);
    };
    let _family = workers::family_lock(data, &root)?;
    if lead(data, id).is_none() {
        return Ok(());
    }
    match session::lifecycle(&spec.dir) {
        (Some(_), _) => session::tidy(&spec),
        (None, Value::Null) => one(data, id, Guard::Lossless),
        _ => Ok(()),
    }
}

/// What an archive of `id` before left: its finished workers, and what they kept of it.
fn again(data: &Path, id: &str) {
    let Ok(_family) = workers::family_lock(data, id) else {
        return;
    };
    if session::lifecycle(&core::session_dir(data, id)).0.is_none() {
        return;
    }
    for e in archive(data, id, false) {
        eprintln!("brigadierd: a worker of archived {id}: {e}");
    }
}

/// The daemon's start, off its way: what archives and restores cut short, or from before workers
/// went with them, left.
pub fn sweep(data: &Path) {
    let cut = || {
        session::cut(data, |id| match lead(data, id) {
            Some(_) => stop_idle(data, id),
            None => stop(data, id, "archive"),
        })
    };
    // The git a daemon that died left running ends in a while; what still can't waits for the next start.
    let _ = [2, 4, 8, 16, 32].iter().any(|wait| {
        let done = !cut();
        if !done {
            thread::sleep(Duration::from_secs(*wait));
        }
        done
    });
    for id in core::ids(data) {
        let dir = core::session_dir(data, &id);
        if session::lifecycle(&dir).0.is_none() {
            continue;
        }
        if lead(data, &id).is_some() {
            // With its family's topmost.
            continue;
        }
        let worker = workers::link(data, &id);
        match worker.filter(|_| session::went_with(&dir)) {
            // Its chat's restore was cut short.
            Some(l) if core::session_dir(data, &l.parent).exists() => {
                if let Ok(spec) = core::load(data, &id)
                    && let Err(e) = restore(data, &spec)
                {
                    eprintln!("brigadierd: restoring worker {id}: {e}");
                }
            }
            _ => again(data, &id),
        }
    }
}
