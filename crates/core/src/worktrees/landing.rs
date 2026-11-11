//! Land's part of a session's record [D1028, D1049]: its last landing into the base, which goes
//! wherever the record goes [D1082], and whether the branch still holds work that never landed.

use super::{err, git, has_branch, lock, read, write};
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

/// A landing into the base [D1028, D1049]: the session's HEAD it landed and the commit that
/// landed it, so a squashed branch counts as landed while that commit is in the base and the
/// session hasn't changed since.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Landing {
    pub head: String,
    pub commit: String,
    pub style: String,
    pub at_ms: u64,
}

/// What Land reads of a session's record: its main checkout, base, branch and last landing.
pub struct Lands {
    pub repo: PathBuf,
    pub base: String,
    pub base_commit: String,
    pub branch: Option<String>,
    pub landing: Option<Landing>,
}

/// The session's record as Land reads it; none without a worktree.
pub fn lands(dir: &Path) -> io::Result<Option<Lands>> {
    Ok(read(dir)?.map(|o| Lands {
        repo: PathBuf::from(o.repo),
        base: o.base,
        base_commit: o.base_commit,
        branch: o.branch,
        landing: o.landing,
    }))
}

/// Records a landing in the session's record, or puts back the one before (None: none).
pub fn set_landing(dir: &Path, landing: Option<Landing>) -> io::Result<()> {
    let _one = lock(dir)?;
    let Some(mut owned) = read(dir)? else {
        return err("This session has no worktree.".into());
    };
    owned.landing = landing;
    write(dir, &owned)
}

/// Whether `landing` still holds: its commit is in the base, and the branch is still at the HEAD
/// it landed. Anything git can't answer counts as not landed, so delete asks [D181, D1049].
pub fn landed(repo: &Path, base: &str, tip: &str, landing: &Landing) -> bool {
    tip == landing.head
        && git(
            repo,
            &["merge-base", "--is-ancestor", &landing.commit, base],
        )
        .is_ok()
}

/// The session's branch when it holds work its base doesn't, uncommitted changes included: the
/// delete confirm names it [D181]. A check git can't answer counts as unlanded, so it asks.
pub fn unlanded(dir: &Path) -> io::Result<Option<String>> {
    let Some(owned) = read(dir)? else {
        return Ok(None);
    };
    let repo = Path::new(&owned.repo);
    let Some(branch) = owned.branch.filter(|b| has_branch(repo, b)) else {
        return Ok(None);
    };
    let dirty = owned
        .path
        .as_deref()
        .map(Path::new)
        .filter(|p| p.exists())
        .is_some_and(|p| git(p, &["status", "--porcelain"]).map_or(true, |s| !s.is_empty()));
    let landed = git(repo, &["merge-base", "--is-ancestor", &branch, &owned.base]).is_ok()
        || (owned.landing.as_ref()).is_some_and(|l| {
            git(repo, &["rev-parse", &format!("refs/heads/{branch}")])
                .is_ok_and(|tip| landed(repo, &owned.base, &tip, l))
        });
    Ok((dirty || !landed).then_some(branch))
}
