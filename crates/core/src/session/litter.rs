//! What an archive takes beyond the worktree: throwaway files, and branches their base holds. Best
//! effort: what won't go waits for the daemon's next start, or delete.

use super::{ARCHIVED, SETUP, clear, holder, lifecycle, shared_claim, sharers};
use crate::worktrees::{self, lost};
use crate::{Spec, adapters, as_run, check_id, projects, share};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::{fs, io};

/// Takes them. The caller holds `lock`; `freed`: whose record held its folder, if it went.
pub(super) fn drop(spec: &Spec, freed: Option<&Path>) {
    let dir = &spec.dir;
    let _ = crate::background::drop_temp(dir);
    if let Ok(f) = crate::fold(dir, true) {
        for (backend, account, id) in &f.fold.convs {
            let Some(a) = adapters::get(backend).filter(|_| check_id(id).is_ok()) else {
                continue;
            };
            for path in a.scratch(&as_run(spec, &f.fold, backend, Some(account)), id) {
                let _ = fs::remove_dir_all(&path);
                // The project's, once empty.
                let _ = path.parent().map(fs::remove_dir);
            }
        }
    }
    let mut shed = |rec: &Path| {
        if let Err(e) = worktrees::shed(rec) {
            eprintln!("{}: {e}", rec.display());
        }
    };
    freed.into_iter().for_each(&mut shed);
    for (_, rec) in crate::folder::claims(dir) {
        if let Ok(_one) = worktrees::lock(&rec) {
            shed(&rec);
        }
    }
}

/// The same for one archived before: its branch may have gone in since, or what worked from it gone.
pub fn tidy(spec: &Spec) -> io::Result<()> {
    let _one = worktrees::lock(&spec.dir)?;
    if !matches!(lifecycle(&spec.dir), (Some(_), Value::Null)) {
        return Ok(());
    }
    let (others, _held) = sharers(spec)?;
    let gone = others.iter().all(|o| lifecycle(&o.dir).0.is_some());
    drop(spec, gone.then(|| holder(spec, &others)).as_deref());
    Ok(())
}

/// What a finished worker's worktree, and its claims, would lose: the build output that makes itself
/// again. None while another session works in that folder.
pub fn built(data: &Path, spec: &Spec) -> io::Result<Vec<PathBuf>> {
    let picks = (spec.project.as_deref())
        .and_then(|id| projects::get(data, id).ok())
        .map(|p| p.include)
        .unwrap_or_default();
    let mut all = match (share::others(data, spec).iter()).all(|o| o.dir.join(ARCHIVED).exists()) {
        true => lost::rebuilt(&spec.dir, &picks)?,
        false => vec![],
    };
    for (_, rec) in crate::folder::claims(&spec.dir) {
        let _one = worktrees::lock(&rec)?;
        if !shared_claim(data, spec, &rec) {
            all.extend(lost::rebuilt(&rec, &picks)?);
        }
    }
    Ok(all)
}

/// Where that waits for its removal: an archive or a delete takes it too.
fn trash(dir: &Path) -> PathBuf {
    crate::background::tmp(dir).join(".built")
}

/// Takes it out of the way, so its removal holds nothing up, and has setup run again before the next
/// turn. The caller holds `lock`.
pub fn unbuild(spec: &Spec, built: &[PathBuf]) -> io::Result<()> {
    for name in SETUP {
        clear(&spec.dir, name)?;
    }
    let to = trash(&spec.dir);
    fs::create_dir_all(&to)?;
    let named = super::now_ms();
    for (i, path) in built.iter().enumerate() {
        fs::rename(path, to.join(format!("{named}-{i}")))?;
    }
    Ok(())
}

/// Removes what it took out, one cut short too.
pub fn unbuilt(dir: &Path) -> io::Result<()> {
    match fs::remove_dir_all(trash(dir)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}
