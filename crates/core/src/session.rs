//! Operations on a whole session: delete.

use crate::fold::Fold;
use crate::{Spec, adapters, as_run, check_id, sweep};
use serde_json::{Value, json};
use std::{fs, io};

/// Removes the session folder and every recorded path outside it. Reports what stayed.
pub fn delete(spec: &Spec, f: &Fold) -> Value {
    let swept = sweep(f);
    // Preserve transcripts too when a checkpoint fails: delete must remain retryable [D35].
    let kept_branches = match crate::worktrees::delete(&spec.dir) {
        Ok(branch) => branch.into_iter().collect::<Vec<_>>(),
        Err(e) => {
            return json!({"ok": false, "swept": swept, "removed": [],
            "left": [format!("worktree: {e}"), format!("{}: kept to try again", spec.dir.display())],
            "kept_branches": []});
        }
    };
    let (mut removed, mut left, mut keep) = (vec![], vec![], false);
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
        // Failed: the folder stays, and its log keeps the ids a later delete tries again with.
        if let Err(e) = a.forget(spec, id) {
            left.push(format!("{backend}: {e}"));
            keep = true;
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
    if keep {
        left.push(format!("{}: kept to try again", spec.dir.display()));
    } else {
        match fs::remove_dir_all(&spec.dir) {
            Ok(()) => removed.push(spec.dir.display().to_string()),
            Err(e) => left.push(format!("{}: {e}", spec.dir.display())),
        }
    }
    json!({"ok": left.is_empty(), "swept": swept, "removed": removed, "left": left,
        "kept_branches": kept_branches})
}
