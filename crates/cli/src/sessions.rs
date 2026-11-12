//! Archive, restore and delete [D35, D180, D181, D198]: the session's host stops first, then
//! core does the work under the session's lock. Each answers the folder's time after its marks,
//! so the row that shows it has `touched` as late. Remove project runs the same delete on each
//! of its sessions [D172, D179].

use crate::{arg, flag, has, index, owner, workers};
use brigadier_core::{self as core, fold, projects, session};
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    let spec = core::load(data, id)?;
    match args[0].as_str() {
        // Settled first too: an archived session gets no host to settle with.
        "archive" if has(args, "--check") => return Ok(check(data, &args[1..])),
        "archive" => crate::rewind::settled(data, &spec)
            .and_then(|()| core::git::recover::settled(data, id))
            .and_then(|()| session::archive(&spec, || stop(data, id, "archive")))?,
        "restore" => session::restore(data, &spec)?,
        // Proposed: `--check` names the branch the confirm asks about [D181].
        _ if has(args, "--check") => {
            // Its whole worker family goes with it [D3017]: the confirm lists their work too.
            let family: Vec<String> = workers::below(data, id)
                .into_iter()
                .map(|r| r.wid)
                .collect();
            let mut reply = check(data, &[&args[1..2], &family[..]].concat());
            reply["branch"] = session::unlanded(&spec)?.into();
            reply["stays"] = session::stays(&spec).into();
            reply["workers"] = workers::unlanded(data, &family).into();
            return Ok(reply);
        }
        _ => return workers::delete(data, id, flag(args, "--branch") == Some("delete")),
    }
    Ok(json!({"ok": true, "at": index::touched(&spec.dir)}))
}

/// What archive's or delete's confirm says first [D1197]: which of `ids` has an agent working,
/// stopped by it, and what each folder they free together loses (`archive <id>… --check`).
fn check(data: &Path, ids: &[String]) -> Value {
    let ids: Vec<String> = (ids.iter().filter(|a| !a.starts_with("--")).cloned()).collect();
    let all = procs::all();
    let running: Vec<&String> = ids.iter().filter(|s| working(data, s, &all)).collect();
    json!({"ok": true, "running": running, "lost": core::worktrees::lost::losses(data, &ids)})
}

fn stop(data: &Path, id: &str, by: &str) -> io::Result<()> {
    let _ = owner::call(data, id, json!({"op": "stop", "by": by}));
    owner::release(data, id)
}

/// One session's delete: its host stops, then core deletes it, recording its intent first.
pub(crate) fn delete(data: &Path, id: &str, drop: bool, by: &str) -> io::Result<Value> {
    let spec = core::load(data, id)?;
    // A rewind cut short finishes or rolls back first, or its unheard conversation leaks [D35].
    crate::rewind::settled(data, &spec)?;
    // A Replace all cut short too: its record goes with the folder.
    core::git::recover::settled(data, id)?;
    stop(data, id, by)?;
    let f = core::fold(&spec.dir, false)?;
    crate::attach::sweep_home(data);
    Ok(session::delete(&spec, &f.fold, drop))
}

/// Whether a session is busy, by core's one test [D172]. One that can't be read isn't: its
/// delete then says why.
pub(crate) fn busy(data: &Path, id: &str, all: &[procs::Proc]) -> bool {
    let dir = core::session_dir(data, id);
    // Waits out a turn start that passed its check before the marker (`session::fence`).
    let Ok(_fence) = core::worktrees::lock(&dir) else {
        return true;
    };
    working(data, id, all)
}

/// Whether a session is busy, taking no lock of its own: for a check under the checkout lock,
/// which a turn start holds until its turn is logged (`session::fence`).
pub(crate) fn working(data: &Path, id: &str, all: &[procs::Proc]) -> bool {
    core::fold(&core::session_dir(data, id), false).is_ok_and(|f| {
        let live = fold::live(&f.fold, owner::state(data, id), data, all);
        session::busy(&f.fold, &live)
    })
}

/// Held through one of our own changes to `folder`: none of the other sessions working there
/// starts a turn meanwhile, and the change is refused while one works [D1082].
pub(crate) fn guard(
    data: &Path,
    folder: &Path,
    except: Option<&str>,
) -> io::Result<Option<fs::File>> {
    let all = std::cell::OnceCell::new();
    core::share::guard(data, folder, except, &|o| {
        working(data, &o.id, all.get_or_init(procs::all))
    })
}

/// Bytes a folder takes on disk, its links not followed.
fn size(path: &Path) -> u64 {
    let mut stack = vec![path.to_path_buf()];
    let mut total = 0;
    while let Some(next) = stack.pop() {
        let Ok(meta) = fs::symlink_metadata(&next) else {
            continue;
        };
        total += meta.blocks() * 512;
        if meta.is_dir() {
            stack.extend(
                fs::read_dir(&next)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .map(|e| e.path()),
            );
        }
    }
    total
}

/// `projects remove <id> [--check | --drop <session id,…>]` (PROPOSED flags and replies) [D172,
/// D179, D181]. `--check` is the old dialog's preview: the sessions (and which are busy), their
/// worktrees and size, merged branches, and each branch with work that never landed. Without it,
/// each session goes through 1v's delete, its branch too only when `--drop` names it; the record
/// goes once none is left. Anything left keeps the record (PROPOSED): a recorded delete retries
/// at the next start, and Remove can run again.
pub fn remove_project(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 2)?;
    let project = projects::get(data, id)?;
    let ids = projects::sessions(data, id)?;
    let all = procs::all();
    if has(args, "--check") {
        let (mut worktrees, mut bytes, mut merged, mut branches) = (0, 0, 0, vec![]);
        for s in &ids {
            let dir = core::session_dir(data, s);
            if core::worktrees::present(&dir) {
                worktrees += 1;
                bytes += size(&core::worktrees::path(data, s));
            }
            match core::worktrees::unlanded(&dir)? {
                Some(branch) => branches.push(json!({"id": s, "branch": branch})),
                None => merged += core::worktrees::branch(&dir)?.is_some() as usize,
            }
        }
        let working: Vec<_> = ids.iter().filter(|s| busy(data, s, &all)).collect();
        return Ok(json!({"ok": true, "sessions": ids, "working": working,
            "worktrees": worktrees, "bytes": bytes, "merged": merged, "branches": branches,
            "removing": project.removing, "lost": core::worktrees::lost::losses(data, &ids)}));
    }
    // Settling needs a host, which is refused once the project is marked as being removed.
    for s in &ids {
        core::load(data, s)
            .and_then(|spec| crate::rewind::settled(data, &spec))
            .map_err(|e| io::Error::other(format!("{s}: {e}")))?;
    }
    // New work in it is refused from here on; busy is checked again under that [D172].
    projects::set_removing(data, id, true)?;
    let all = procs::all();
    let working = ids.iter().filter(|s| busy(data, s, &all)).count();
    if working > 0 {
        projects::set_removing(data, id, false)?;
        return Err(io::Error::other(format!(
            "{working} of its sessions {} working. Stop {} or let {} finish first.",
            if working == 1 { "is" } else { "are" },
            if working == 1 { "it" } else { "them" },
            if working == 1 { "it" } else { "them" },
        )));
    }
    let drops: Vec<&str> = flag(args, "--drop").unwrap_or("").split(',').collect();
    let (mut kept, mut left) = (vec![], vec![]);
    for s in &ids {
        match delete(data, s, drops.contains(&s.as_str()), "remove") {
            Ok(reply) => {
                kept.extend(
                    reply["kept_branches"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .cloned(),
                );
                left.extend(reply["left"].as_array().into_iter().flatten().cloned());
            }
            // Nothing recorded yet, so nothing retries on its own.
            Err(e) => left.push(format!("{s}: {e}. Run Remove again.").into()),
        }
    }
    if left.is_empty() {
        // The CLIs' own trust entries go back first; a failed one keeps its record and the
        // project, so Remove again retries it [D35, D166].
        match core::trust::restore(data, id).and_then(|()| projects::remove(data, id)) {
            Ok(()) => {
                return Ok(json!({"ok": true, "repo": project.folder, "kept_branches": kept}));
            }
            Err(e) => left.push(e.to_string().into()),
        }
    }
    projects::set_removing(data, id, false)?;
    Ok(json!({"ok": false, "repo": project.folder, "kept_branches": kept, "left": left}))
}
