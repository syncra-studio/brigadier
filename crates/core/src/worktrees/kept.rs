//! The branch a session's delete leaves whatever the confirm's choice [D703].

use super::{Owned, has_branch, read};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Every other record, a session's or a folder chat's claim, than `dir`'s.
pub(super) fn others(dir: &Path) -> impl Iterator<Item = Owned> {
    let mine = dir.to_path_buf();
    let session = (dir.ancestors().find(|d| d.join("session.json").exists())).unwrap_or(dir);
    (session
        .parent()
        .and_then(|d| fs::read_dir(d).ok())
        .into_iter()
        .flatten()
        .flatten())
    .flat_map(|e| {
        let claims = crate::folder::claims(&e.path())
            .into_iter()
            .map(|(_, rec)| rec);
        claims.chain([e.path()]).collect::<Vec<PathBuf>>()
    })
    .filter(move |rec| *rec != mine)
    .filter_map(|rec| read(&rec).ok().flatten())
}

/// Why delete leaves the branch whatever it's told [D703]: "pr", a branch it found there (a PR's), or
/// "shared", one another session's record names too, its work on it.
pub(super) fn keeps(dir: &Path, owned: &Owned, branch: &str) -> Option<&'static str> {
    if owned.on {
        return Some("pr");
    }
    others(dir)
        .any(|o| o.repo == owned.repo && o.branch.as_deref() == Some(branch))
        .then_some("shared")
}

/// `keeps` for delete's confirm: the session's branch and why delete leaves it, if it does.
pub fn kept(dir: &Path) -> io::Result<Option<(String, &'static str)>> {
    let Some(owned) = read(dir)? else {
        return Ok(None);
    };
    let repo = Path::new(&owned.repo);
    Ok((owned.branch.clone().filter(|b| has_branch(repo, b)))
        .and_then(|b| keeps(dir, &owned, &b).map(|why| (b, why))))
}
