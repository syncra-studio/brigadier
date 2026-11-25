//! A chat's finished workers go with its archive, at any depth, and come back with its restore: each
//! archived as the chat is, marked as gone with it, so no list shows it as a chat archived. One at
//! work then goes when it finishes; what a crash cut short goes on at the daemon's start.

use super::{family, stop, unarchived};
use crate::workers;
use brigadier_core::{self as core, session, session::Guard};
use brigadier_frames::procs;
use serde_json::Value;
use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::Mutex;

/// The archived session above worker `wid` that is nearest, and the family's topmost; None for one
/// under none, or a Brigade's session.
pub(super) fn lead(data: &Path, wid: &str) -> Option<(String, String)> {
    let (mut at, mut near, mut top) = (wid.to_string(), None, None);
    while let Some(l) = workers::link(data, &at).filter(|l| !l.session) {
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
    (family(data, id).into_iter())
        .filter(|r| r.state != "starting" && unarchived(&core::session_dir(data, &r.wid)))
        .map(|r| r.wid)
        .filter(|w| !workers::at_work(data, w, all))
        .collect()
}

/// Archives `id`'s finished workers, then drops what they kept of it. Those that failed, with why.
/// The caller holds `id`'s family lock.
pub(super) fn archive(data: &Path, id: &str, new: bool) -> Vec<String> {
    let mut stayed = vec![];
    // Its confirm named what theirs lose; later nobody is asked.
    let guard = match new {
        true => Guard::Named,
        false => Guard::Lossless,
    };
    let all = procs::all();
    let gone = finished(data, id, &all);
    for wid in &gone {
        if let Err(e) = one(data, wid, guard) {
            let dir = core::session_dir(data, wid);
            let title =
                core::load(data, wid).map_or(dir.display().to_string(), |s| core::share::title(&s));
            stayed.push(format!("{title}: {e}"));
        }
    }
    // A worker's folder that was based on its branch held that.
    if !(new && gone.is_empty())
        && let Ok(spec) = core::load(data, id)
    {
        let _ = session::tidy(&spec);
    }
    stayed
}

/// One worker's archive, unless it's at work again.
fn one(data: &Path, wid: &str, guard: Guard) -> io::Result<()> {
    let spec = core::load(data, wid)?;
    crate::agent::new::settle(data, wid)?;
    crate::rewind::settled(data, &spec)?;
    core::git::recover::settled(data, wid)?;
    let works = || workers::at_work(data, wid, &procs::all());
    let done = session::archive(&spec, true, guard, || match works() {
        // Under its lock, so no turn starts after the look.
        true => Err(io::Error::other("it's at work")),
        false => stop(data, wid, "archive"),
    });
    match done {
        Err(_) if works() => Ok(()),
        done => done,
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
            if r.session || (archived && !session::went_with(&dir)) {
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
    session::archives(data);
    for id in core::ids(data) {
        let dir = core::session_dir(data, &id);
        if session::lifecycle(&dir).0.is_none() {
            continue;
        }
        if lead(data, &id).is_some() {
            // What a guard kept, once nothing in it is lost.
            if let Ok(spec) = core::load(data, &id)
                && !session::own(data, &spec).is_empty()
                && let Err(e) = session::tidy(&spec)
            {
                eprintln!("brigadierd: archived worker {id}: {e}");
            }
            continue;
        }
        let worker = workers::link(data, &id).filter(|l| !l.session);
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
