//! Operations on a whole session: archive, restore and delete [D35, D180, D181, D198]. Each runs
//! under the session's worktree lock and records its intent first, so one cut short finishes or
//! rolls back at the daemon's next start; while one is recorded, or the session is archived, it
//! takes no new work.

use crate::fold::Fold;
use crate::{
    Spec, adapters, as_run, check_id, ids, projects, session_dir, sweep as kill_left, worktrees,
    write_atomic,
};
use brigadier_frames::log::now_ms;
use serde_json::{Value, json};
use std::path::Path;
use std::{fs, io};

/// The operation under way (`op`: archive, restore or delete), the delete's branch choice, and
/// what a delete couldn't remove.
const INTENT: &str = "lifecycle.json";
/// When the session was archived (ms).
const ARCHIVED: &str = "archived";
/// O27, proposed and switchable: a restore in a trusted project runs its setup script again
/// before the next turn, since the worktree's ignored files (node_modules…) went with it [D180].
const RESTORE_RERUNS_SETUP: bool = true;

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

/// Why the session takes no new work now (a start, send, recover or terminal), if it doesn't.
pub fn closed(dir: &Path) -> Option<&'static str> {
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

/// Archives the session [D180]: `stop` ends its host (a running turn too, proposed), then its
/// work is committed to its branch and the worktree freed; a session with none is only marked.
pub fn archive(spec: &Spec, stop: impl FnOnce()) -> io::Result<()> {
    let _one = worktrees::lock(&spec.dir)?;
    if spec.dir.join(ARCHIVED).exists() {
        return Ok(());
    }
    record(&spec.dir, &json!({"op": "archive"}))?;
    stop();
    finish_archive(&spec.dir)
}

fn finish_archive(dir: &Path) -> io::Result<()> {
    match worktrees::free(dir) {
        Ok(()) => {
            write_atomic(&dir.join(ARCHIVED), now_ms().to_string().as_bytes())?;
            clear(dir, INTENT)
        }
        // Nothing went yet: the session stays as it was. Half gone: the next start finishes it.
        Err(e) => {
            if worktrees::present(dir) {
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
    let project = spec
        .project
        .as_deref()
        .and_then(|id| projects::get(data, id).ok());
    let picks = project
        .as_ref()
        .map(|p| p.include.clone())
        .unwrap_or_default();
    if let Err(e) = worktrees::restore(&spec.dir, &picks) {
        // Rolled back: it stays archived and can be restored again.
        if !worktrees::present(&spec.dir) {
            clear(&spec.dir, INTENT)?;
        }
        return Err(e);
    }
    // Only after the worktree is back, never on an ordinary respawn [D8, D16].
    if RESTORE_RERUNS_SETUP && project.is_some_and(|p| p.trusted == Some(true)) {
        for name in ["setup.started", "setup.exit", "setup.log"] {
            clear(&spec.dir, name)?;
        }
    }
    clear(&spec.dir, ARCHIVED)?;
    clear(&spec.dir, INTENT)
}

/// The branch a delete would ask about, if any [D181].
pub fn unlanded(spec: &Spec) -> io::Result<Option<String>> {
    worktrees::unlanded(&spec.dir)
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
    if let Err(e) = record(dir, &json!({"op": "delete", "drop_branch": drop_branch})) {
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
        if let Err(e) = a.forget(spec, id) {
            left.push(format!("{backend}: {e}"));
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
                Err(e) => left.push(format!("{}: {e}", path.display())),
            }
        }
        // Shared folders go only once empty: other sessions may still have files in them.
        for path in a.shared(spec) {
            if fs::remove_dir(&path).is_ok() {
                removed.push(path.display().to_string());
            }
        }
    }
    // Anything left keeps the folder: its log holds the ids a later delete tries again with.
    if !left.is_empty() {
        left.push(format!("{}: kept to try again", dir.display()));
        let mut reply = fail(left, swept);
        reply["removed"] = removed.into();
        reply["kept_branches"] = kept_branches.into();
        return reply;
    }
    match fs::remove_dir_all(dir) {
        Ok(()) => removed.push(dir.display().to_string()),
        Err(e) => left.push(format!("{}: {e}", dir.display())),
    }
    json!({"ok": left.is_empty(), "swept": swept, "removed": removed, "left": left,
        "kept_branches": kept_branches})
}

/// At the daemon's start, after `worktrees::sweep`'s own: an archive cut short finishes, a restore
/// rolls back (the session stays archived), a delete runs again with the choice it was given.
pub fn sweep(data: &Path) {
    for id in ids(data) {
        let dir = session_dir(data, &id);
        let Some(cut) = intent(&dir) else { continue };
        match cut["op"].as_str() {
            Some("archive") => {
                if let Ok(_one) = worktrees::lock(&dir) {
                    let _ = finish_archive(&dir);
                }
            }
            Some("restore") => {
                if let Ok(_one) = worktrees::lock(&dir)
                    && worktrees::free(&dir).is_ok()
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
