//! Land's part of a session's record [D1028, D1049]: its last landing into the base, which goes
//! wherever the record goes [D1082], and whether the branch still holds work that never landed.

use super::{git, has_branch, live, read, write};
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

/// A host-verified merge is recorded only while the recorded branch, base and clean HEAD agree.
/// The caller holds the session's `lock`, then the checkout lock, in that order; the ordinary
/// landing/delete guards recheck it later.
pub fn external_landing(
    dir: &Path,
    branch: &str,
    base: &str,
    head: &str,
    commit: &str,
) -> io::Result<()> {
    if !oid(head) || !oid(commit) {
        return Ok(());
    }
    let Some(mut owned) = read(dir)? else {
        return Ok(());
    };
    if owned.branch.as_deref() != Some(branch) || owned.base != base {
        return Ok(());
    }
    let Some(path) = owned.path.as_deref().map(Path::new) else {
        return Ok(());
    };
    let same = super::branch::at(path)? == branch
        && git(path, &["rev-parse", "HEAD"])? == head
        && git(path, &["status", "--porcelain", "--untracked-files=all"])?.is_empty();
    let repo = Path::new(&owned.repo);
    let held = |base: String| git(repo, &["merge-base", "--is-ancestor", commit, &base]).is_ok();
    if !same || !base_ref(repo, base).is_some_and(held) {
        return Ok(());
    }
    if owned
        .landing
        .as_ref()
        .is_some_and(|l| l.head == head && l.commit == commit)
    {
        return Ok(());
    }
    owned.landing = Some(Landing {
        head: head.into(),
        commit: commit.into(),
        style: "host".into(),
        at_ms: brigadier_frames::log::now_ms(),
    });
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
/// delete confirm names it [D181]. A check git can't answer counts as unlanded, so it asks. A
/// folder chat's claimed repos' too, each as `<repo> <branch>` [D494].
pub fn unlanded(dir: &Path) -> io::Result<Option<String>> {
    let mut all: Vec<String> = own_unlanded(dir)?.into_iter().collect();
    for (name, rec) in crate::folder::claims(dir) {
        all.extend(own_unlanded(&rec)?.map(|b| format!("{name} {b}")));
    }
    Ok((!all.is_empty()).then(|| all.join(", ")))
}

/// The same of one record: the session's own, or a claim's.
pub fn own_unlanded(dir: &Path) -> io::Result<Option<String>> {
    let Some(owned) = read(dir)? else {
        return Ok(None);
    };
    let repo = Path::new(&owned.repo);
    let Some(branch) = owned.branch.clone().filter(|b| has_branch(repo, b)) else {
        return Ok(None);
    };
    // What the checkpoint would take.
    let status = |p: &Path| {
        let held = super::inner::held(p)?;
        let args = ["status", "--porcelain", "--"].into_iter();
        git(
            p,
            &args
                .chain(held.iter().map(String::as_str))
                .collect::<Vec<_>>(),
        )
    };
    let dirty = live(&owned).is_some_and(|p| status(p).map_or(true, |s| !s.is_empty()));
    Ok((dirty || !in_base(repo, &owned.base, &branch, owned.landing.as_ref())).then_some(branch))
}

/// Whether the session's commits are all in its base, its uncommitted files aside: "Merged into
/// ‹base›" [D97]. True without a branch; a check git can't answer counts as not merged. A folder
/// chat's claimed repos must all be merged too [D494].
pub fn merged(dir: &Path) -> io::Result<bool> {
    for (_, rec) in crate::folder::claims(dir) {
        if !own_merged(&rec)? {
            return Ok(false);
        }
    }
    own_merged(dir)
}

fn own_merged(dir: &Path) -> io::Result<bool> {
    let Some(owned) = read(dir)? else {
        return Ok(true);
    };
    let repo = Path::new(&owned.repo);
    let branch = owned.branch.filter(|b| has_branch(repo, b));
    Ok(branch.is_none_or(|b| in_base(repo, &owned.base, &b, owned.landing.as_ref())))
}

fn oid(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// What a record's `base` names, in full, as git reads a short name as a tag first: one named in
/// full already, a branch, an archived session's that went as its own base holds it, a remote's,
/// one named past `refs/`, or a commit.
fn base_ref(repo: &Path, base: &str) -> Option<String> {
    (base.starts_with("refs/").then_some(""))
        .into_iter()
        .chain(["refs/heads/", super::freed::REFS, "refs/remotes/", "refs/"])
        .map(|at| format!("{at}{base}"))
        .find(|r| git(repo, &["rev-parse", "--verify", "--quiet", r]).is_ok())
        .or_else(|| oid(base).then(|| base.into()))
}

/// The branch is in `base`, by ancestry or a landing that still holds.
pub(super) fn in_base(repo: &Path, base: &str, branch: &str, landing: Option<&Landing>) -> bool {
    let Some(base) = base_ref(repo, base) else {
        return false;
    };
    let branch = format!("refs/heads/{branch}");
    git(repo, &["merge-base", "--is-ancestor", &branch, &base]).is_ok()
        || landing.is_some_and(|l| {
            git(repo, &["rev-parse", &branch]).is_ok_and(|tip| landed(repo, &base, &tip, l))
        })
}
