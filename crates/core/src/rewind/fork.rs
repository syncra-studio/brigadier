//! Fork's whole surface on rewind [D1068, D1089]: the files an answer's turn ended with, written
//! into a fork's new worktree, and the crash record of a fork made from this session, finished or
//! rolled back by rewind's settle, by the phase it reached [D35, D54].

use super::snap::{Shot, Store};
use crate::fold::Boundary;
use crate::{CallIn, Spec, adapters, as_run, data_of, session_dir, worktrees, write_atomic};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;
use std::{fs, io};

pub(super) const OP: &str = "fork.json";

/// The folder as turn `cid` ended, for a fork [D1068]. `head` is None once that commit is gone.
pub fn end_of(spec: &Spec, cid: &str) -> Option<Shot> {
    let store = Store::of(spec)?;
    let mut end = store.load(cid)?.end?;
    end.head = end.head.filter(|h| store.has(h));
    Some(end)
}

/// The folder now, tracked changes and untracked files, for a fork from a turn with no snapshot [D1068].
pub fn now_of(spec: &Spec) -> io::Result<Shot> {
    Store::of(spec)
        .ok_or_else(|| io::Error::other("no snapshots here"))?
        .capture()
}

/// Writes `shot`'s differing paths into `into`, a fork's worktree; returns those left as they were.
pub fn write_shot(spec: &Spec, shot: &Shot, into: &Path) -> io::Result<Vec<String>> {
    let store = Store::of(spec).ok_or_else(|| io::Error::other("no snapshots here"))?;
    write_into(&store, shot, into)
}

/// The same from any store: a folder chat's claimed repo's [D3105].
pub fn write_into(store: &Store, shot: &Shot, into: &Path) -> io::Result<Vec<String>> {
    let store = store.over(into)?;
    let now = store.capture()?;
    let wanted: BTreeSet<String> = (store.diff(&now, shot)?.into_iter())
        .filter(|p| !shot.out.contains_key(p))
        .collect();
    let (blocked, paths): (BTreeSet<String>, BTreeSet<String>) =
        (wanted.iter().cloned()).partition(|p| store.blocked(p, &wanted));
    store.write_back(&shot.tree, &paths)?;
    Ok(shot.out.keys().cloned().chain(blocked).collect())
}

/// A fork under way, rewritten before each step: `prepared`; `files`, before the fork's folder and
/// worktree are made; `conversation`, before the native fork, with `before` the forks `at.conv`
/// already had; `made`, with `record`, all the fork's own record says [D1089].
#[derive(Serialize, Deserialize, Default)]
pub struct Op {
    pub phase: String,
    pub fork: String,
    pub backend: String,
    pub account: String,
    pub at: Option<Boundary>,
    pub before: Vec<String>,
    pub record: Value,
}

pub fn write(spec: &Spec, op: &mut Op, phase: &str) -> io::Result<()> {
    op.phase = phase.into();
    write_atomic(&spec.dir.join(OP), &serde_json::to_vec(op)?)?;
    if std::env::var("BRIGADIER_CRASH_AT").is_ok_and(|at| at == format!("fork:{phase}")) {
        std::process::abort();
    }
    Ok(())
}

/// Done: only the record goes, never through rewind's settle, which would wait on the fence [D1089].
pub fn clear(spec: &Spec) -> io::Result<()> {
    match fs::remove_file(spec.dir.join(OP)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// A half-made fork goes whole: its worktree, registration and branch through wave 1's removal,
/// then its folder [D35].
pub fn remove(data: &Path, id: &str) -> io::Result<()> {
    let dir = session_dir(data, id);
    if !dir.exists() {
        return Ok(());
    }
    {
        let _one = worktrees::lock(&dir)?;
        worktrees::delete(&dir, true)?;
        crate::folder::delete(&dir, true)?;
    }
    fs::remove_dir_all(&dir)
}

/// Every conversation a session records: never removed as an unheard fork [D204].
fn owned(data: &Path) -> BTreeSet<String> {
    (crate::ids(data).iter())
        .filter_map(|id| crate::fold(&session_dir(data, id), true).ok())
        .flat_map(|f| f.fold.convs.into_iter().map(|(_, _, conv)| conv))
        .collect()
}

/// Removes a native fork that was never heard about, found by this operation's record only.
pub fn unfork(source: &Spec, op: &Op) -> io::Result<()> {
    let (Some(at), Some(a)) = (&op.at, adapters::get(&op.backend).and_then(|a| a.forking())) else {
        return Ok(());
    };
    let f = crate::fold(&source.dir, true)?.fold;
    let run = as_run(source, &f, &op.backend, Some(&op.account));
    a.unfork(&run, &at.conv, &op.before, &owned(&data_of(source)))
        .map_err(io::Error::other)
}

/// Finishes or rolls back a fork cut short. The caller holds the source's worktree lock.
pub(super) fn settle(spec: &Spec, call_in: CallIn) -> io::Result<()> {
    let Ok(bytes) = fs::read(spec.dir.join(OP)) else {
        return Ok(());
    };
    let op: Op = serde_json::from_slice(&bytes)?;
    let data = data_of(spec);
    match op.phase.as_str() {
        "prepared" => {}
        "files" => remove(&data, &op.fork)?,
        "conversation" => {
            unfork(spec, &op)?;
            remove(&data, &op.fork)?;
        }
        // Discarded before its record was written: only an unheard native fork is left [D35].
        _ if !session_dir(&data, &op.fork).exists() => unfork(spec, &op)?,
        _ => crate::fork::made(&data, &op.record, call_in)?,
    }
    clear(spec)
}
