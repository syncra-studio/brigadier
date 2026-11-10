//! Operations on a whole session: archive, restore and delete [D35, D180, D181, D198]. Each runs
//! under the session's worktree lock and records its intent first, so one cut short finishes or
//! rolls back at the daemon's next start; while one is recorded, or the session is archived, it
//! takes no new work.

use crate::fold::{Fold, Live, Owner};
use crate::{
    Spec, adapters, as_run, check_id, data_of, ids, projects, session_dir, share,
    sweep as kill_left, worktrees, write_atomic,
};
use brigadier_frames::log::now_ms;
use serde_json::{Value, json};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::{fs, io};

/// The operation under way (`op`: archive, restore or delete), the delete's branch choice, and
/// what a delete couldn't remove.
const INTENT: &str = "lifecycle.json";
/// When the session was archived (ms).
const ARCHIVED: &str = "archived";

fn intent(dir: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(dir.join(INTENT)).ok()?).ok()
}

fn record(dir: &Path, intent: &Value) -> io::Result<()> {
    write_atomic(&dir.join(INTENT), &serde_json::to_vec(intent)?)
}

fn clear(dir: &Path, name: &str) -> io::Result<()> {
    match fs::remove_file(dir.join(name)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// When it was archived, and the operation recorded on it: what its row shows.
pub fn lifecycle(dir: &Path) -> (Option<u64>, Value) {
    let archived = fs::read_to_string(dir.join(ARCHIVED))
        .ok()
        .and_then(|s| s.trim().parse().ok());
    (archived, intent(dir).unwrap_or(Value::Null))
}

/// Why the session takes no new work now (a start, send or recover), if it doesn't.
pub fn closed(dir: &Path) -> Option<&'static str> {
    let unsettled =
        crate::rewind::pending(dir).then_some("A rewind of this session hasn't finished.");
    let forking = (dir.join(crate::fork::FORKING).exists()).then_some("This fork isn't made yet.");
    retired(dir).or(unsettled).or(forking)
}

/// Why it can't have a host at all. A rewind cut short needs one to finish.
pub fn retired(dir: &Path) -> Option<&'static str> {
    match intent(dir).as_ref().and_then(|i| i["op"].as_str()) {
        Some("archive") => Some("This session is being archived."),
        Some("restore") => Some("This session is being restored."),
        Some(_) => Some("This session is being deleted."),
        None => dir
            .join(ARCHIVED)
            .exists()
            .then_some("This session is archived. Restore it to continue."),
    }
}

/// Held by a turn's start from this check until its turn is logged, and by Remove project around
/// its busy check, so a send that raced the marker is either seen as busy or refused here [D172].
/// The second lock keeps a turn from starting in a folder while a restore, or one of our own
/// changes to a shared folder, writes there; any folder, as a "here" fork shares even a worktree
/// [D1070, D1089].
pub fn fence(data: &Path, spec: &Spec) -> io::Result<(File, Option<File>)> {
    let lock = worktrees::lock(&spec.dir)?;
    let removing = projects::removing(data, spec).then_some("This project is being removed.");
    if let Some(why) = closed(&spec.dir).or(removing) {
        return Err(io::Error::other(why));
    }
    let shared = crate::rewind::checkout_lock(data, false)?;
    Ok((lock, Some(shared)))
}

/// Archives the session [D180]: `stop` ends its host (a running turn too, proposed), then its
/// work is committed to its branch and the worktree freed; a session with none is only marked.
pub fn archive(spec: &Spec, stop: impl FnOnce() -> io::Result<()>) -> io::Result<()> {
    let _one = worktrees::lock(&spec.dir)?;
    if spec.dir.join(ARCHIVED).exists() {
        return Ok(());
    }
    record(&spec.dir, &json!({"op": "archive"}))?;
    // A host that won't exit may still be working in the worktree: nothing goes, nothing is left to finish.
    if let Err(e) = stop() {
        clear(&spec.dir, INTENT)?;
        return Err(e);
    }
    finish_archive(spec)
}

/// The other sessions in this one's folder, and the checkout lock held while there are any, so
/// none starts a turn or changes hands meanwhile [D1080]. The caller holds its own `lock`.
fn sharers(spec: &Spec) -> io::Result<(Vec<Spec>, Option<File>)> {
    let data = data_of(spec);
    let others = share::others(&data, spec);
    let held = (!others.is_empty())
        .then(|| crate::rewind::checkout_lock(&data, true))
        .transpose()?;
    Ok((others, held))
}

/// Whose record holds the folder's worktree: this session's own, else another user's.
fn holder(spec: &Spec, others: &[Spec]) -> PathBuf {
    (others.iter())
        .find(|o| !worktrees::made(&spec.dir) && worktrees::made(&o.dir))
        .map_or(spec.dir.clone(), |o| o.dir.clone())
}

fn finish_archive(spec: &Spec) -> io::Result<()> {
    let dir = &spec.dir;
    let (others, _held) = sharers(spec)?;
    // Another still working there keeps the folder; the last user archived frees it [D1080].
    let holder =
        (!others.iter().any(|o| !o.dir.join(ARCHIVED).exists())).then(|| holder(spec, &others));
    match holder.as_deref().map_or(Ok(()), worktrees::free) {
        Ok(()) => {
            write_atomic(&dir.join(ARCHIVED), now_ms().to_string().as_bytes())?;
            clear(dir, INTENT)
        }
        // Nothing went yet: the session stays as it was. Half gone: the next start finishes it.
        Err(e) => {
            if holder.as_deref().is_none_or(worktrees::present) {
                clear(dir, INTENT)?;
            }
            Err(e)
        }
    }
}

/// Brings an archived session back: its worktree again on its branch, with its files to copy.
pub fn restore(data: &Path, spec: &Spec) -> io::Result<()> {
    let _one = worktrees::lock(&spec.dir)?;
    if !spec.dir.join(ARCHIVED).exists() {
        return Ok(());
    }
    record(&spec.dir, &json!({"op": "restore"}))?;
    // A shared worktree comes back for any of its users, from its holder's record [D1080].
    let (others, _held) = sharers(spec)?;
    let holder = holder(spec, &others);
    let own = holder == spec.dir;
    let was = worktrees::present(&holder);
    let project = spec
        .project
        .as_deref()
        .and_then(|id| projects::get(data, id).ok());
    let picks = project
        .as_ref()
        .map(|p| p.include.clone())
        .unwrap_or_default();
    if let Err(e) = worktrees::restore(&holder, &picks) {
        // Rolled back: it stays archived and can be restored again.
        if !worktrees::present(&holder) {
            clear(&spec.dir, INTENT)?;
        }
        return Err(e);
    }
    // Restore always re-runs setup in trusted projects before the next turn [D263]; a shared
    // worktree's, only when this brought it back.
    if project.is_some_and(|p| p.trusted == Some(true)) && (own || !was) {
        for name in ["setup.started", "setup.exit", "setup.log"] {
            clear(&holder, name)?;
        }
    }
    clear(&spec.dir, ARCHIVED)?;
    clear(&spec.dir, INTENT)
}

/// Whether the session is busy, whatever its mark: a live host with a turn not yet ended
/// (waiting on you or stalled too) or background work, or a host that can't be told [D172].
pub fn busy(f: &Fold, live: &Live) -> bool {
    match live.owner {
        Owner::Frozen => true,
        Owner::Alive => !f.turns.is_empty() || live.jobs > 0,
        Owner::Dead => false,
    }
}

/// The branch a delete would ask about, if any [D181]: none while another session uses the
/// folder, which keeps it [D1080].
pub fn unlanded(spec: &Spec) -> io::Result<Option<String>> {
    if !share::others(&data_of(spec), spec).is_empty() {
        return Ok(None);
    }
    worktrees::unlanded(&spec.dir)
}

/// Who still works in the folder after this session goes, for the confirm [D1080].
pub fn stays(spec: &Spec) -> Option<String> {
    share::others(&data_of(spec), spec)
        .first()
        .map(|o| o.id.clone())
}

/// While others use the folder, its worktree's record goes to the oldest not being deleted
/// itself, landing with it [D1080, D1082], named in the intent first so a crash finishes the same
/// handover [D35]. Only users left archived: it's freed, as the last archive would [D180].
fn hand_on(spec: &Spec, intent: &mut Value) -> io::Result<bool> {
    let (others, _held) = sharers(spec)?;
    if others.is_empty() {
        return Ok(false);
    }
    let archived = others.iter().all(|o| o.dir.join(ARCHIVED).exists());
    // A user with no record leaving only archived ones: the holder's worktree is freed [D180].
    if !worktrees::made(&spec.dir) {
        if archived {
            worktrees::free(&holder(spec, &others))?;
        }
        return Ok(false);
    }
    let deleting = |o: &Spec| self::intent(&o.dir).is_some_and(|i| i["op"] == "delete");
    let named = intent["heir"].as_str().map(String::from);
    let Some(heir) = (others.iter())
        .find(|o| named.as_ref() == Some(&o.id))
        .or_else(|| others.iter().find(|o| !deleting(o)))
    else {
        return Ok(false);
    };
    intent["heir"] = heir.id.clone().into();
    intent["keep"] = worktrees::folder(&spec.dir)
        .map(|p| p.display().to_string())
        .into();
    record(&spec.dir, intent)?;
    worktrees::handover(&spec.dir, &heir.dir)?;
    if archived {
        worktrees::free(&heir.dir)?;
    }
    Ok(true)
}

/// Removes the session folder and every recorded path outside it, its branch too when `drop`
/// says so or it all landed. Anything left keeps the folder and its record, so the daemon's next
/// start tries again with the same choice; the reply says what stayed.
pub fn delete(spec: &Spec, f: &Fold, drop_branch: bool) -> Value {
    let dir = &spec.dir;
    let fail = |left: Vec<String>, swept: usize| {
        let _ = record(
            dir,
            &json!({"op": "delete", "drop_branch": drop_branch, "left": left}),
        );
        json!({"ok": false, "swept": swept, "removed": [], "left": left, "kept_branches": []})
    };
    let _one = match worktrees::lock(dir) {
        Ok(one) => one,
        Err(e) => return fail(vec![format!("{}: {e}", dir.display())], 0),
    };
    // A rewind can start after the caller settled it; keep its record recoverable [D35].
    if crate::rewind::pending(dir) {
        return json!({"ok": false, "swept": 0, "removed": [],
            "left": ["A rewind of this session hasn't finished."], "kept_branches": []});
    }
    let mut cut = intent(dir)
        .filter(|i| i["op"] == "delete")
        .unwrap_or_default();
    cut["op"] = "delete".into();
    cut["drop_branch"] = drop_branch.into();
    if let Err(e) = record(dir, &cut).and_then(|()| hand_on(spec, &mut cut)) {
        return fail(vec![format!("{}: {e}", dir.display())], 0);
    }
    let swept = kill_left(f);
    // Preserve transcripts too when a checkpoint fails: delete must remain retryable [D35].
    let kept_branches = match worktrees::delete(dir, drop_branch) {
        Ok(branch) => branch.into_iter().collect::<Vec<_>>(),
        Err(e) => {
            return fail(
                vec![
                    format!("worktree: {e}"),
                    format!("{}: kept to try again", dir.display()),
                ],
                swept,
            );
        }
    };
    let (mut removed, mut left) = (vec![], vec![]);
    for (backend, account, id) in &f.convs {
        let Some(a) = adapters::get(backend) else {
            continue;
        };
        // Each conversation is cleaned where it lives: its account's home [D35, D51].
        let spec = &as_run(spec, f, backend, Some(account));
        // The id came from the CLI's output: never let an odd one widen what gets deleted.
        if check_id(id).is_err() {
            left.push(format!(
                "{backend}: unusual resume id {id:?}, nothing removed"
            ));
            continue;
        }
        // A failed forget keeps its files: they're how a retry knows there's still something to do.
        if let Err(e) = a.forget(spec, id) {
            left.push(format!("{backend}: {e}"));
            continue;
        }
        for path in a.external(spec, id) {
            let gone = if path.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            };
            match gone {
                Ok(()) => removed.push(path.display().to_string()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => {
                    left.push(format!("{}: {e}", path.display()));
                }
            }
        }
        // Shared folders go only once empty: other sessions may still have files in them.
        for path in a.shared(spec) {
            if fs::remove_dir(&path).is_ok() {
                removed.push(path.display().to_string());
            }
        }
    }
    left.extend(crate::writer::forget(spec, f));
    // Anything left keeps the folder: its log holds the ids a later delete tries again with.
    if !left.is_empty() {
        left.push(format!("{}: kept to try again", dir.display()));
        let mut reply = fail(left, swept);
        reply["removed"] = removed.into();
        reply["kept_branches"] = kept_branches.into();
        return reply;
    }
    match remove(dir) {
        Ok(()) => removed.push(dir.display().to_string()),
        Err(e) => left.push(format!("{}: {e}", dir.display())),
    }
    json!({"ok": left.is_empty(), "swept": swept, "removed": removed, "left": left,
        "kept_branches": kept_branches})
}

/// Rolls back a restore cut short: its worktree is freed again, unless another session still
/// works there unarchived [D1080].
fn undo_restore(spec: &Spec) -> io::Result<()> {
    let (others, _held) = sharers(spec)?;
    if others.iter().any(|o| !o.dir.join(ARCHIVED).exists()) {
        return Ok(());
    }
    worktrees::free(&holder(spec, &others))
}

/// The session's folder goes; one still holding a worktree another uses keeps only that, its
/// record last, so a crash leaves it a session that deletes again [D35, D1080].
fn remove(dir: &Path) -> io::Result<()> {
    if !dir.join(worktrees::RETAINED).exists() {
        return fs::remove_dir_all(dir);
    }
    let keep = ["worktree", worktrees::RETAINED, "session.json", INTENT];
    for entry in fs::read_dir(dir)?.flatten() {
        if keep.iter().any(|k| entry.file_name() == *k) {
            continue;
        }
        match entry.file_type()?.is_dir() {
            true => fs::remove_dir_all(entry.path())?,
            false => fs::remove_file(entry.path())?,
        }
    }
    fs::remove_file(dir.join("session.json"))?;
    clear(dir, INTENT)
}

/// At the daemon's start, after `worktrees::sweep`'s own: an archive cut short finishes, a restore
/// rolls back (the session stays archived), a delete runs again with the choice it was given.
pub fn sweep(data: &Path) {
    for id in ids(data) {
        let dir = session_dir(data, &id);
        let Some(cut) = intent(&dir) else { continue };
        match cut["op"].as_str() {
            Some("archive") => {
                if let (Ok(_one), Ok(spec)) = (worktrees::lock(&dir), crate::load(data, &id)) {
                    let _ = finish_archive(&spec);
                }
            }
            Some("restore") => {
                if let (Ok(_one), Ok(spec)) = (worktrees::lock(&dir), crate::load(data, &id))
                    && undo_restore(&spec).is_ok()
                {
                    let _ = clear(&dir, INTENT);
                }
            }
            _ => {
                if let (Ok(spec), Ok(f)) = (crate::load(data, &id), crate::fold(&dir, false)) {
                    delete(&spec, &f.fold, cut["drop_branch"] == true);
                }
            }
        }
    }
}
