//! Archive, restore and delete [D35, D180, D181, D198]: the session's host stops first, then
//! core does the work under the session's lock. Each answers the folder's time after its marks,
//! so the row that shows it has `touched` as late. Remove project runs the same delete on each
//! of its sessions [D172, D179].
//! A job a turn left running is stopped here too, alone [D105].

use crate::{arg, flag, has, index, owner, workers};
use brigadier_core::{self as core, fold, projects, session};
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

mod audit;
mod jobs;
mod servers;
pub(crate) use jobs::end as end_jobs;
use jobs::family;

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    let spec = match core::load(data, id) {
        // One already deleted, with its Brigade or by another delete, has nothing to check or remove.
        Err(e) if e.kind() == io::ErrorKind::NotFound && args[0] == "delete" => {
            return Ok(match has(args, "--check") {
                true => json!({"ok": true}),
                false => session::gone(&core::session_dir(data, id)),
            });
        }
        spec => spec?,
    };
    match args[0].as_str() {
        "audit" => return audit::run(&spec, args),
        // Settled first too: an archived session gets no host to settle with.
        "archive" if has(args, "--check") => return Ok(check(data, &args[1..])),
        // Every id given, each loaded first so an unknown one refuses before any is archived.
        "archive" => {
            let ids = args[1..].iter().filter(|a| !a.starts_with("--"));
            let specs: Vec<_> = ids
                .map(|id| core::load(data, id).map(|s| (id, s)))
                .collect::<io::Result<_>>()?;
            let mut running = vec![];
            for (id, spec) in specs {
                running.extend(archive(data, id, &spec, false)?);
                // A Brigade's sessions go with it, each archived as it would be alone; one that
                // fails stays and is named, and those archived stay archived [D3111].
                let failed: Vec<String> = (subs(data, &spec, unarchived).iter())
                    .filter_map(|sub| {
                        match core::load(data, sub).and_then(|s| archive(data, sub, &s, true)) {
                            Ok(more) => running.extend(more),
                            Err(e) => return Some(format!("{sub}: {e}")),
                        }
                        None
                    })
                    .collect();
                if !failed.is_empty() {
                    let failed = failed.join("; ");
                    return Err(io::Error::other(format!(
                        "its sessions not archived: {failed}"
                    )));
                }
            }
            // All are archived; a worker's process that wouldn't stop is named.
            if !running.is_empty() {
                let running = running.join("; ");
                return Err(io::Error::other(format!(
                    "archived, but its workers' processes still run: {running}"
                )));
            }
        }
        // The Brigade's restore brings back the sessions archived with it, not one archived on
        // its own before [D3111].
        "restore" => {
            let with = subs(data, &spec, session::went_with);
            session::restore(data, &spec)?;
            let failed: Vec<String> = (with.iter())
                .filter_map(|sub| {
                    let e = core::load(data, sub).and_then(|s| session::restore(data, &s));
                    e.err().map(|e| format!("{sub}: {e}"))
                })
                .collect();
            if !failed.is_empty() {
                let failed = failed.join("; ");
                return Err(io::Error::other(format!(
                    "its sessions not restored: {failed}"
                )));
            }
        }
        // `jobs <id> history`: everything that ran in the background, its workers' too, each with
        // its worker's name, newest first [D200].
        "jobs" if arg(args, 2)? == "history" => {
            let all = procs::all();
            let runs = |dir: &Path| {
                let f = core::fold(dir, true)?;
                let left = fold::live(&f.fold, fold::Owner::Alive, dir, &all).left;
                Ok::<_, io::Error>(fold::history(dir, &left))
            };
            let mut history = runs(&spec.dir)?;
            for r in family(data, id) {
                let dir = core::session_dir(data, &r.wid);
                if dir.join(fold::HISTORY).exists() {
                    history.extend(runs(&dir)?.into_iter().map(|mut run| {
                        run["owner"] = r.title.clone().into();
                        run
                    }));
                }
            }
            history.sort_by_key(|run| std::cmp::Reverse(run["startedAt"].as_u64()));
            return Ok(json!({"ok": true, "history": history}));
        }
        // `jobs <id> servers`: the local servers its steps printed, while a job its turns left runs, and
        // its terminals, while their shell runs [D508, D315].
        "jobs" if arg(args, 2)? == "servers" => {
            let f = core::fold(&spec.dir, true)?;
            let left = fold::live(&f.fold, fold::Owner::Alive, &spec.dir, &procs::all()).left;
            let shells = crate::tabs::terminal::printed(data, id);
            let servers = servers::of(&spec.dir, !left.is_empty(), shells);
            return Ok(json!({"ok": true, "servers": servers}));
        }
        // `jobs <id> stop <pid> <start_us>`: one process tree its turns left running [D105].
        "jobs" => {
            let f = core::fold(&spec.dir, true)?;
            let num = |i| arg(args, i)?.parse().map_err(io::Error::other);
            let (pid, start_us) = (num(3)? as i32, num(4)?);
            return jobs::stop(data, &spec, &f.fold, pid, start_us);
        }
        // Off for a folder chat that claimed a repo: its confirm doesn't name the repos' branches
        // yet [D3102]. A start that never took still goes.
        "delete" if core::folder::chat(&spec) && !core::folder::claims(&spec.dir).is_empty() => {
            return Err(io::Error::other(
                "Delete isn't available yet in a chat on a folder of repos.",
            ));
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
        // Its terminals go too, also those of one cut short before [repo D35].
        _ => {
            let done = workers::delete(data, id, flag(args, "--branch") == Some("delete"));
            crate::tabs::terminal::sweep(data);
            return done;
        }
    }
    crate::tabs::terminal::sweep(data);
    Ok(json!({"ok": true, "at": index::touched(&spec.dir)}))
}

/// What archive's or delete's confirm says first [D1197]: which of `ids` has an agent working,
/// stopped by it, and what each folder they free together loses (`archive <id>… --check`).
/// A Brigade's sessions that go with it are checked too, and listed under it in `with` [D3111].
fn check(data: &Path, ids: &[String]) -> Value {
    let mut ids: Vec<String> = (ids.iter().filter(|a| !a.starts_with("--")).cloned()).collect();
    // One picked as well isn't counted twice.
    let family: Vec<(String, Vec<String>)> = (ids.iter())
        .filter_map(|id| core::load(data, id).ok())
        .map(|s| {
            let subs = subs(data, &s, unarchived);
            (
                s.id,
                subs.into_iter().filter(|x| !ids.contains(x)).collect(),
            )
        })
        .filter(|(_, subs): &(String, Vec<String>)| !subs.is_empty())
        .collect();
    ids.extend(family.iter().flat_map(|(_, subs)| subs.iter().cloned()));
    let with: serde_json::Map<String, Value> = (family.into_iter())
        .map(|(id, subs)| (id, subs.into()))
        .collect();
    let all = procs::all();
    let running: Vec<&String> = (ids.iter())
        .filter(|s| workers::at_work(data, s, &all))
        .collect();
    json!({"ok": true, "running": running, "lost": core::worktrees::lost::losses(data, &ids), "with": with})
}

/// A Brigade's sessions whose folder passes `keep`, oldest first [D3111].
fn subs(data: &Path, spec: &core::Spec, keep: fn(&Path) -> bool) -> Vec<String> {
    (spec.brigade.then(|| workers::records(data, &spec.id)))
        .into_iter()
        .flatten()
        .filter(|r| r.session && keep(&core::session_dir(data, &r.wid)))
        .map(|r| r.wid)
        .collect()
}

/// Those an archive takes with their Brigade: ones that exist, not archived, with no archive,
/// restore or delete recorded, so a delete left unfinished keeps its record [D35, D3111].
fn unarchived(dir: &Path) -> bool {
    dir.join("session.json").exists() && matches!(session::lifecycle(dir), (None, Value::Null))
}

/// One session's archive: what a rewind or Replace all cut short settles first, its host stops,
/// then core archives it. `with`: a Brigade's session going with it [D3111]. Archived, its workers
/// whose processes didn't stop.
fn archive(data: &Path, id: &str, spec: &core::Spec, with: bool) -> io::Result<Vec<String>> {
    let _family = workers::family_lock(data, id)?;
    crate::agent::new::settle(data, id)?;
    crate::rewind::settled(data, spec)
        .and_then(|()| core::git::recover::settled(data, id))
        .and_then(|()| workers::left::archive(data, spec, with, || stop(data, id, "archive")))?;
    // What its finished workers left running goes; one at work keeps its own.
    let running = (family(data, id).iter())
        .filter_map(|w| {
            let e = end_jobs(data, &w.wid).err()?;
            Some(format!("{}: {e}", w.title))
        })
        .collect();
    // Its tab groups go, its own and a worker's in its parent's row: the tabs stay the user's [D901 D909].
    let parent = crate::workers::link(data, id).map(|l| l.parent);
    for owner in [Some(id.to_string()), parent].into_iter().flatten() {
        let args = ["tabs", &owner, "ungroup", id].map(String::from);
        crate::tabs::run(data, &args)?;
    }
    Ok(running)
}

fn stop(data: &Path, id: &str, by: &str) -> io::Result<()> {
    // Its terminals first: none writes into its folder while it is checkpointed or removed.
    crate::tabs::terminal::stop_all(data, id);
    let _ = owner::call(data, id, json!({"op": "stop", "by": by}));
    // First: the host waits for whoever still holds its agent's output.
    core::background::end_left(&core::session_dir(data, id))?;
    owner::release(data, id)
}

/// One session's delete: its host stops, then core deletes it, recording its intent first. One
/// whose folder went meanwhile, by its Brigade's delete or its own, is done [D35].
pub(crate) fn delete(data: &Path, id: &str, drop: bool, by: &str) -> io::Result<Value> {
    let dir = core::session_dir(data, id);
    match delete_one(data, id, drop, by) {
        Err(e) if e.kind() == io::ErrorKind::NotFound && !dir.join("session.json").exists() => {
            Ok(session::gone(&dir))
        }
        done => done,
    }
}

fn delete_one(data: &Path, id: &str, drop: bool, by: &str) -> io::Result<Value> {
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
    let lead = crate::workers::link(data, id).map(|l| l.parent);
    let reply = session::delete(&spec, &f.fold, drop);
    if let Some(lead) = lead.filter(|_| reply["ok"] == true) {
        crate::relay::mockup::deleted(data, &lead, id);
    }
    Ok(reply)
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
    let dir = core::session_dir(data, id);
    core::fold(&dir, false).is_ok_and(|f| {
        let live = fold::live(&f.fold, owner::state(data, id), &dir, all);
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

/// `projects remove <id> [--check]` (PROPOSED flag and replies) [D172, D179, D181]. `--check` is
/// the old dialog's preview: the sessions (and which are busy), their worktrees and size, merged
/// branches, and each branch with work that never landed. Without it, each session goes through
/// 1v's delete, which keeps a branch with such work; the record goes once none is left. Anything
/// left keeps the record (PROPOSED): a recorded delete retries at the next start, and Remove can
/// run again.
pub fn remove_project(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 2)?;
    let project = projects::get(data, id)?;
    let ids = projects::sessions(data, id)?;
    let all = procs::all();
    // Its notes go with it, their side chats first; a working chat holds it as a session does [D920 D922].
    let notes = crate::attach::note::folder(data, Some(id));
    let chats = crate::attach::note::chats_in(&notes);
    let chats_busy = |all: &[procs::Proc]| -> Vec<&String> {
        chats.iter().filter(|c| busy(data, c, all)).collect()
    };
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
        // A working note chat holds it too, so the dialog says so as Remove would [D922].
        working.extend(chats_busy(all));
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
    let working = ids.iter().filter(|s| busy(data, s, &all)).count() + chats_busy(&all).len();
    if working > 0 {
        projects::set_removing(data, id, false)?;
        return Err(io::Error::other(format!(
            "{working} of its sessions {} working. Stop {} or let {} finish first.",
            if working == 1 { "is" } else { "are" },
            if working == 1 { "it" } else { "them" },
            if working == 1 { "it" } else { "them" },
        )));
    }
    // Each delete stops a host and commits and takes away a worktree, a few hundred ms: run side by
    // side, 16 at a time, as --check's reads [D463]. Sessions that share a folder or claim one hand
    // it on between them [D1080], so those go one by one once the rest are done.
    let alone = |s: &String| {
        core::load(data, s).is_ok_and(|spec| {
            Path::new(&spec.cwd) == core::worktrees::path(data, s)
                && core::share::others(data, &spec).is_empty()
                && core::folder::claims(&spec.dir).is_empty()
        })
    };
    let (apart, after): (Vec<&String>, Vec<&String>) = ids.iter().partition(|s| alone(s));
    let one = |s: &String| delete(data, s, false, "remove");
    let mut done = vec![];
    std::thread::scope(|t| {
        for chunk in apart.chunks(16) {
            let each: Vec<_> = (chunk.iter())
                .map(|&s| (s, t.spawn(move || one(s))))
                .collect();
            done.extend(
                each.into_iter()
                    .map(|(s, h)| (s, h.join().expect("remove thread"))),
            );
        }
    });
    done.extend(after.into_iter().map(|s| (s, one(s))));
    let (mut kept, mut left) = (vec![], vec![]);
    for (s, reply) in done {
        match reply {
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
