//! Archive, restore and delete [D35, D180, D181, D198]: the session's host stops first, then
//! core does the work under the session's lock. Each answers the folder's time after its marks,
//! so the row that shows it has `touched` as late. Remove project runs the same delete on each
//! of its sessions [D172, D179].
//! A job a turn left running is stopped here too, alone [D105].

use crate::{arg, control, flag, has, index, owner, workers};
use brigadier_core::{self as core, fold, projects, session};
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

mod audit;
mod servers;

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    let spec = core::load(data, id)?;
    match args[0].as_str() {
        "audit" => return audit::run(&spec, args),
        // Settled first too: an archived session gets no host to settle with.
        "archive" if has(args, "--check") => {
            // A folder chat can't be archived yet: said before the app hides its row [D494].
            let ids = args[1..].iter().filter(|a| !a.starts_with("--"));
            let off = (ids.filter_map(|id| core::load(data, id).ok()))
                .find_map(|s| core::folder::off(&s, "Archive").err());
            return Ok(match off {
                Some(e) => json!({"ok": false, "error": e.to_string()}),
                None => check(data, &args[1..]),
            });
        }
        // Every id given, each loaded first so an unknown one refuses before any is archived.
        "archive" => {
            let ids = args[1..].iter().filter(|a| !a.starts_with("--"));
            let specs: Vec<_> = ids
                .map(|id| core::load(data, id).map(|s| (id, s)))
                .collect::<io::Result<_>>()?;
            for (id, spec) in specs {
                crate::rewind::settled(data, &spec)
                    .and_then(|()| core::git::recover::settled(data, id))
                    .and_then(|()| session::archive(&spec, || stop(data, id, "archive")))?;
                // Its tab groups go, its own and a worker's in its parent's row: the tabs stay the user's [D901 D909].
                let parent = crate::workers::link(data, id).map(|l| l.parent);
                for owner in [Some(id.to_string()), parent].into_iter().flatten() {
                    let args = ["tabs", &owner, "ungroup", id].map(String::from);
                    crate::tabs::run(data, &args)?;
                }
            }
        }
        "restore" => session::restore(data, &spec)?,
        // `jobs <id> history`: everything that ran in the background, newest first [D200].
        "jobs" if arg(args, 2)? == "history" => {
            let f = core::fold(&spec.dir, true)?;
            let left = fold::live(&f.fold, fold::Owner::Alive, data, &procs::all()).left;
            return Ok(json!({"ok": true, "history": fold::history(&spec.dir, &left)}));
        }
        // `jobs <id> servers`: the local servers its steps printed, while a job its turns left runs [D508].
        "jobs" if arg(args, 2)? == "servers" => {
            let f = core::fold(&spec.dir, true)?;
            let left = fold::live(&f.fold, fold::Owner::Alive, data, &procs::all()).left;
            let servers = if left.is_empty() {
                vec![]
            } else {
                servers::of(&spec.dir)
            };
            return Ok(json!({"ok": true, "servers": servers}));
        }
        // `jobs <id> stop <pid> <start_us>`: one process tree its turns left running [D105].
        "jobs" => {
            let f = core::fold(&spec.dir, true)?;
            let num = |i| arg(args, i)?.parse().map_err(io::Error::other);
            let (pid, start_us) = (num(3)? as i32, num(4)?);
            // Its agent hears first, through its CLI's own channel or its adapter's note: else it
            // reads an unexplained kill and may wake to start it again [D117]. One with neither refuses.
            let left = fold::live(&f.fold, fold::Owner::Alive, data, &procs::all()).left;
            // One already gone is stopped.
            let Some(job) = left.iter().find(|j| j.pid == pid && j.start_us == start_us) else {
                return Ok(json!({"ok": true}));
            };
            let task = fold::task_of(&f.fold, start_us);
            let msg = json!({"kind": "stop_task", "task": task, "command": job.label});
            let req = json!({"cid": control::new_cid(), "control": msg});
            let sent = control::deliver(data, id, req, false, |_| Ok(msg.clone()))?;
            if task.is_some() {
                let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
                while sent["ok"] == true && procs::same(pid, start_us).is_some_and(|p| !p.zombie) {
                    if std::time::Instant::now() > until {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
            fold::note_stop(&spec.dir, pid, start_us);
            fold::stop_job(&f.fold, data, pid, start_us);
            return Ok(json!({"ok": true}));
        }
        // Proposed: `--check` names the branch the confirm asks about [D181].
        _ if has(args, "--check") => {
            // Its whole worker family goes with it [D3017]: the confirm lists their work too.
            let family: Vec<String> = workers::below(data, id)
                .into_iter()
                .map(|r| r.wid)
                .collect();
            let mut reply = check(data, &[&args[1..2], &family[..]].concat());
            // A PR's branch or another session's stays whatever the choice: said, not offered [D703].
            let branch = session::unlanded(&spec)?;
            let kept = branch.as_ref().and(core::worktrees::kept(&spec.dir)?);
            reply["branch"] = branch.filter(|_| kept.is_none()).into();
            reply["kept"] = kept.map(|(b, why)| json!({"branch": b, "why": why})).into();
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
    // Its notes are its project's: one still waiting to move keeps the session until it has [D916].
    crate::attach::note::settle(data);
    if crate::attach::note::holds(&spec.dir) {
        return Err(io::Error::other(
            "a note of this session waits for its chat to stop before it moves to the project; try again then",
        ));
    }
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
    // Its notes go with it, their side chats first; a working chat holds it as a session does [D920 D922].
    let notes = crate::attach::note::folder(data, Some(id));
    let chats = crate::attach::note::chats_in(&notes);
    let chats_working = chats.iter().filter(|c| busy(data, c, &all)).count();
    if has(args, "--check") {
        // Each read is a few git processes: run side by side (16 at a time), the preview takes about
        // one session's time instead of their sum, so the dialog can open with it [D463].
        let all = &all;
        let (facts, lost) = std::thread::scope(|t| {
            let lost = t.spawn(|| core::worktrees::lost::losses(data, &ids));
            let mut facts = vec![];
            for chunk in ids.chunks(16) {
                let each: Vec<_> = (chunk.iter())
                    .map(|s| {
                        t.spawn(move || -> io::Result<_> {
                            let dir = core::session_dir(data, s);
                            // A folder chat's claimed copies are all in its own folder [D494].
                            let has = core::worktrees::present(&dir)
                                || !core::folder::claims(&dir).is_empty();
                            let bytes = has.then(|| size(&core::worktrees::path(data, s)));
                            let unlanded = core::worktrees::unlanded(&dir)?;
                            let merged =
                                unlanded.is_none() && core::worktrees::branch(&dir)?.is_some();
                            Ok((bytes, unlanded, merged, busy(data, s, all)))
                        })
                    })
                    .collect();
                facts.extend(each.into_iter().map(|h| h.join().expect("check thread")));
            }
            (facts, lost.join().expect("check thread"))
        });
        let (mut worktrees, mut bytes, mut merged, mut branches, mut working) =
            (0, 0, 0, vec![], vec![]);
        for (s, fact) in ids.iter().zip(facts) {
            let (size, unlanded, landed, busy) = fact?;
            if let Some(size) = size {
                worktrees += 1;
                bytes += size;
            }
            if let Some(branch) = unlanded {
                branches.push(json!({"id": s, "branch": branch}));
            }
            merged += landed as usize;
            if busy {
                working.push(s);
            }
        }
        let count = (fs::read_dir(&notes).into_iter().flatten().flatten())
            .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
            .count();
        return Ok(
            json!({"ok": true, "sessions": ids, "working": working, "notes": count,
            "worktrees": worktrees, "bytes": bytes, "merged": merged, "branches": branches,
            "removing": project.removing, "lost": lost}),
        );
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
    let working = ids.iter().filter(|s| busy(data, s, &all)).count() + chats_working;
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
    if left.is_empty()
        && let Err(e) = crate::attach::note::drop_chats(data, &notes)
    {
        left.push(format!("a note's chat: {e}. Run Remove again.").into());
    }
    if left.is_empty() {
        // The CLIs' own trust entries go back first; a failed one keeps its record and the
        // project, so Remove again retries it [D35, D166].
        match core::trust::restore(data, id).and_then(|()| projects::remove(data, id)) {
            Ok(()) => {
                // Each adapter's own empty per-project folders (Claude's memory, its project
                // folder), by the main checkout's path, not any session's worktree [D212].
                let spec = core::Spec {
                    cwd: project.folder.clone(),
                    ..Default::default()
                };
                for a in core::adapters::all() {
                    for dir in a.shared(&spec) {
                        let _ = fs::remove_dir(&dir);
                    }
                }
                return Ok(json!({"ok": true, "repo": project.folder, "kept_branches": kept}));
            }
            Err(e) => left.push(e.to_string().into()),
        }
    }
    projects::set_removing(data, id, false)?;
    Ok(json!({"ok": false, "repo": project.folder, "kept_branches": kept, "left": left}))
}
