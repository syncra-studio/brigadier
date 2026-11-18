//! The branch a session's delete leaves whatever the confirm's choice [D703].

use super::{Owned, has_branch, read};
use std::fs;
use std::io;
use std::path::Path;

/// Why delete leaves the branch whatever it's told [D703]: "pr", a branch it found there (a PR's), or
/// "shared", one another session's record names too, its work on it. Those are `dir`'s siblings.
pub(super) fn keeps(dir: &Path, owned: &Owned, branch: &str) -> Option<&'static str> {
    if owned.on {
        return Some("pr");
    }
    let mut siblings = dir
        .parent()
        .and_then(|d| fs::read_dir(d).ok())
        .into_iter()
        .flatten()
        .flatten();
    siblings
        .any(|e| {
            Some(e.file_name().as_os_str()) != dir.file_name()
                && matches!(read(&e.path()), Ok(Some(o)) if o.repo == owned.repo && o.branch.as_deref() == Some(branch))
        })
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
