//! An archived session's branch goes once its base holds all of it. A ref of ours keeps its commit,
//! whatever becomes of the base, so restore makes the same branch again; delete takes the ref.

use super::{Owned, err, git, has_branch, kept, landing, live, read, write};
use serde::{Deserialize, Serialize};
use std::io;
use std::path::Path;

/// Where those commits are kept: no name a new session may take.
pub(super) const REFS: &str = "refs/brigadier/freed/";

#[derive(Serialize, Deserialize, Clone)]
pub(super) struct Freed {
    branch: String,
    commit: String,
    #[serde(default)]
    upstream: String,
}

impl Freed {
    fn name(&self) -> String {
        format!("{REFS}{}", self.branch)
    }

    /// Takes the ref; one gone, its repository too, is done.
    pub(super) fn forget(&self, repo: &Path) -> io::Result<()> {
        match git(repo, &["rev-parse", "--verify", "--quiet", &self.name()]) {
            Ok(_) => git(repo, &["update-ref", "-d", &self.name()]).map(drop),
            Err(_) => Ok(()),
        }
    }
}

fn tip(repo: &Path, branch: &str) -> io::Result<String> {
    git(repo, &["rev-parse", &format!("refs/heads/{branch}")])
}

/// Whether another session's worktree in place started from it: its diff is against it.
fn based(dir: &Path, owned: &Owned, branch: &str) -> bool {
    kept::others(dir).any(|o| o.repo == owned.repo && o.base == branch && live(&o).is_some())
}

/// Whether the session's kept PRs (`prs.json`) have an open one from `branch`, as its last read saw.
fn open_pr(dir: &Path, branch: &str) -> bool {
    let session = (dir.ancestors().find(|d| d.join("session.json").exists())).unwrap_or(dir);
    (crate::host::kept(session)["prs"].as_array()).is_some_and(|prs| {
        prs.iter()
            .any(|p| p["branch"] == branch && p["repo"].is_null() && p["state"] == "open")
    })
}

/// Drops a freed worktree's branch when its base holds all of it; one with work not merged, a PR's
/// or another session's stays, or one another works from [D181, D703]. Recorded before it goes, so one cut short runs again.
/// The caller holds `lock`.
pub fn shed(dir: &Path) -> io::Result<()> {
    let Some(mut owned) = read(dir)? else {
        return Ok(());
    };
    let Some(branch) = owned.branch.clone().filter(|_| live(&owned).is_none()) else {
        return Ok(());
    };
    let repo = Path::new(&owned.repo).to_path_buf();
    if has_branch(&repo, &branch) {
        if kept::keeps(dir, &owned, &branch).is_some()
            || open_pr(dir, &branch)
            || based(dir, &owned, &branch)
            || !landing::in_base(&repo, &owned.base, &branch, owned.landing.as_ref())
        {
            return Ok(());
        }
        let commit = tip(&repo, &branch)?;
        let name = format!("refs/heads/{branch}");
        let upstream = git(
            &repo,
            &["for-each-ref", "--format=%(upstream:short)", &name],
        )?;
        let freed = Freed {
            branch,
            commit,
            upstream,
        };
        git(&repo, &["update-ref", &freed.name(), &freed.commit])?;
        owned.freed = Some(freed.clone());
        write(dir, &owned)?;
        // Not one checked out anywhere, which git refuses.
        if let Err(e) = git(&repo, &["branch", "-D", &freed.branch]) {
            if freed.forget(&repo).is_ok() {
                owned.freed = None;
                write(dir, &owned)?;
            }
            return Err(e);
        }
    } else if owned.freed.is_none() {
        return Ok(());
    }
    owned.branch = None;
    write(dir, &owned)
}

/// Makes the branch `shed` dropped again, at the same commit, for restore.
pub(super) fn bring_back(dir: &Path, owned: &mut Owned) -> io::Result<()> {
    let Some(freed) = owned.freed.clone() else {
        return Ok(());
    };
    let repo = Path::new(&owned.repo).to_path_buf();
    // Back already, but for the ref.
    let back = (owned.branch.as_ref()).is_some_and(|b| has_branch(&repo, b));
    match has_branch(&repo, &freed.branch) {
        _ if back => {}
        true if tip(&repo, &freed.branch)? != freed.commit => {
            return err(format!(
                "Another branch is named {} now. Rename it, then restore.",
                freed.branch
            ));
        }
        true => {}
        false => drop(git(
            &repo,
            &["branch", "--no-track", &freed.branch, &freed.commit],
        )?),
    }
    if !back && !freed.upstream.is_empty() {
        let to = format!("--set-upstream-to={}", freed.upstream);
        // One gone meanwhile has nothing to follow.
        let _ = git(&repo, &["branch", &to, &freed.branch]);
    }
    if !back {
        owned.branch = Some(freed.branch.clone());
        write(dir, owned)?;
    }
    // One that won't go now is its next restore's, or delete's.
    if freed.forget(&repo).is_ok() {
        owned.freed = None;
        write(dir, owned)?;
    }
    Ok(())
}
