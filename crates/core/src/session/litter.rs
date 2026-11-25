//! What an archive takes beyond the worktree: build output, throwaway files, and branches their base
//! holds. One routine and one set of guards for the archive, the daemon's start and Free up space.
//! Best effort: what won't go waits for the daemon's next start, or delete.

use super::{ARCHIVED, SETUP, clear, holder, lifecycle, shared_claim, sharers};
use crate::worktrees::{
    self,
    lost::{self, Guard},
};
use crate::{Spec, adapters, as_run, check_id, data_of, projects, share};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::{fs, io};

/// The project's include rules, which a restore copies by into each of its worktrees.
fn picks(data: &Path, spec: &Spec) -> Vec<String> {
    (spec.project.as_deref())
        .and_then(|id| projects::get(data, id).ok())
        .map(|p| p.include)
        .unwrap_or_default()
}

/// Whether `guard` lets a worktree of `spec`'s be freed.
pub(crate) fn guarded(spec: &Spec, guard: Guard) -> impl Fn(&Path) -> bool {
    let picks = picks(&data_of(spec), spec);
    move |rec| lost::may_go(rec, &picks, guard)
}

/// Its worktrees in place, its own and its claims', by record: those no other session needs.
pub fn own(data: &Path, spec: &Spec) -> Vec<PathBuf> {
    let others = share::others(data, spec);
    let alone = others.iter().all(|o| o.dir.join(ARCHIVED).exists());
    let claims = crate::folder::claims(&spec.dir).into_iter();
    let claims = claims
        .map(|(_, rec)| rec)
        .filter(|r| !shared_claim(data, spec, r));
    (alone.then(|| spec.dir.clone()).into_iter().chain(claims))
        .filter(|rec| worktrees::present(rec))
        .collect()
}

/// Whether nothing is lost if all its worktrees go: each holds only what is made again or git has,
/// its work merged. One another needs, or git can't answer for, stays.
pub fn may_take(data: &Path, spec: &Spec) -> bool {
    let may = guarded(spec, Guard::Lossless);
    matches!(worktrees::unlanded(&spec.dir), Ok(None)) && own(data, spec).iter().all(|rec| may(rec))
}

/// Whether an archived session still has a worktree, a branch or throwaway files.
pub fn left(data: &Path, spec: &Spec) -> bool {
    let claims = crate::folder::claims(&spec.dir).into_iter();
    crate::background::tmp(&spec.dir).exists()
        || !own(data, spec).is_empty()
        || (claims.map(|(_, rec)| rec).chain([spec.dir.clone()]))
            .any(|rec| !matches!(worktrees::branch(&rec), Ok(None)))
}

/// Takes them. The caller holds `lock`; `freed`: whose record held its folder, if it went.
pub(super) fn drop(spec: &Spec, freed: Option<&Path>) {
    let dir = &spec.dir;
    // Of what a guard kept.
    let gone = built(&data_of(spec), spec).and_then(|all| match all.is_empty() {
        true => Ok(()),
        false => unbuild(spec, &all),
    });
    if let Err(e) = gone.and_then(|()| unbuilt(dir)) {
        eprintln!("{}: {e}", dir.display());
    }
    // A repository in there may hold work of its own.
    if !lost::repo_inside(&crate::background::tmp(dir), &[]) {
        let _ = crate::background::drop_temp(dir);
    }
    if let Ok(f) = crate::fold(dir, true) {
        for (backend, account, id) in &f.fold.convs {
            let Some(a) = adapters::get(backend).filter(|_| check_id(id).is_ok()) else {
                continue;
            };
            for path in a.scratch(&as_run(spec, &f.fold, backend, Some(account)), id) {
                if lost::repo_inside(&path, &[]) {
                    continue;
                }
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

/// The same for one archived before: its branch may have gone in since, or what worked from it gone;
/// and the worktree a guard kept, once nothing in it is lost.
pub fn tidy(spec: &Spec) -> io::Result<()> {
    let _one = worktrees::lock(&spec.dir)?;
    if !matches!(lifecycle(&spec.dir), (Some(_), Value::Null)) {
        return Ok(());
    }
    let data = data_of(spec);
    let (others, _held) = sharers(spec)?;
    if may_take(&data, spec) {
        for rec in own(&data, spec) {
            // The session's own is locked already.
            let _claim = (rec != spec.dir)
                .then(|| worktrees::lock(&rec))
                .transpose()?;
            worktrees::free(&rec)?;
        }
    }
    let gone = others.iter().all(|o| lifecycle(&o.dir).0.is_some());
    drop(spec, gone.then(|| holder(spec, &others)).as_deref());
    Ok(())
}

/// What its worktrees would lose as a finished worker's: the build output that makes itself again.
pub fn built(data: &Path, spec: &Spec) -> io::Result<Vec<PathBuf>> {
    let picks = picks(data, spec);
    let mut all = vec![];
    for rec in own(data, spec) {
        all.extend(lost::rebuilt(&rec, &picks)?);
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
