//! A title-named worktree at `sessions/<id>/worktree` [D35, D160, D210, D1217].
//! Copies `.worktreeinclude` files [D178] and runs trusted project setup before the first turn
//! [D166, D202, D211]. `worktree.json` records each owned piece for rollback and delete [D35, D181].

use crate::adapters::setup;
pub use crate::worktree_setup::{Startup, setup_state, wrap};
use crate::{Spec, ids, projects, session_dir, write_atomic};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

mod branch;
mod copy;
pub use branch::rename_held;
mod hand;
pub(crate) mod landing;
pub mod lost;
mod missing;
use missing::registration;
pub mod names;
use copy::include;
pub use hand::{RETAINED, folder, handover};
pub use landing::{Landing, Lands, external_landing, landed, lands, merged, unlanded};
pub use missing::restore_missing;

const RECORD: &str = "worktree.json";
/// Proposed: making or removing a worktree of a big repository can take a while.
const GIT_SECS: u64 = 300;

/// What a session owns in its project's repository. Each piece is set once it exists.
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Owned {
    /// The main checkout.
    repo: String,
    /// The branch it started from, or the commit when HEAD was detached (proposed).
    base: String,
    base_commit: String,
    branch: Option<String>,
    path: Option<String>,
    /// Git's own folder for the worktree's registration.
    admin: Option<String>,
    /// An unfinished create: the daemon retries its rollback at its start.
    failed: bool,
    /// A rename under way, recorded before git renames it [D35]: see `branch::settled`.
    renaming: Option<String>,
    /// The last landing into the base: it goes wherever this record goes [D1049, D1082].
    landing: Option<Landing>,
    /// The deleted session that made it and handed it on, whose folder holds it [D1080].
    inherited: Option<String>,
}

fn err<T>(message: String) -> io::Result<T> {
    Err(io::Error::other(message))
}

/// Git in `dir` and nowhere else: what the environment says about another repository is dropped,
/// as the old app's runner did, and it never prompts.
pub(crate) fn command(dir: &Path) -> Command {
    let mut command = with_hooks(dir);
    // Bookkeeping must not run a repository's hooks before its trust gate [D166, D211].
    command.args(["-c", "core.hooksPath=/dev/null"]);
    command
}

/// `command` with the repository's own hooks, for a trusted project's push (Git LFS's pre-push).
pub(crate) fn with_hooks(dir: &Path) -> Command {
    let mut command = Command::new("git");
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_PREFIX",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_CEILING_DIRECTORIES",
        "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    ] {
        command.env_remove(key);
    }
    command.env("GIT_TERMINAL_PROMPT", "0").arg("-C").arg(dir);
    command
}

fn git(dir: &Path, args: &[&str]) -> io::Result<String> {
    let mut command = command(dir);
    command.args(args);
    let out = setup::run(&mut command, GIT_SECS).map_err(io::Error::other)?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return err(format!("git {}: {why}", args.join(" ")));
    }
    Ok(String::from_utf8(out.stdout)
        .map_err(io::Error::other)?
        .trim_end_matches('\n')
        .to_string())
}

/// One create, archive, restore or delete at a time per session.
pub fn lock(dir: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("worktree.lock"))?;
    file.lock()?;
    Ok(file)
}

fn read(dir: &Path) -> io::Result<Option<Owned>> {
    match fs::read(dir.join(RECORD)) {
        Ok(bytes) => Ok(Some(branch::settled(serde_json::from_slice(&bytes)?))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn write(dir: &Path, owned: &Owned) -> io::Result<()> {
    write_atomic(&dir.join(RECORD), &serde_json::to_vec_pretty(owned)?)
}

/// The branch (or commit) a session's worktree started from; none without one.
pub fn base(dir: &Path) -> Option<String> {
    read(dir).ok().flatten().map(|owned| owned.base)
}

/// Where a session's worktree goes.
pub fn path(data: &Path, id: &str) -> PathBuf {
    session_dir(data, id).join("worktree")
}

/// Makes the session's worktree unless it's whole: a start cut short before it was finishes it
/// here, its unfinished create undone first. A failed create on a `fresh` session (made by this
/// start) that undid itself takes the session away too; on a retry the session keeps its log and
/// first message, and the error says why. One it couldn't undo stays recorded [D35].
pub fn ensure(
    spec: &Spec,
    project: &projects::Project,
    fresh: bool,
    base: Option<&str>,
    title: &str,
) -> io::Result<()> {
    {
        let _one = lock(&spec.dir)?;
        match read(&spec.dir)? {
            Some(owned) if !owned.failed => return Ok(()),
            Some(owned) => {
                undo(&owned)?;
                fs::remove_file(spec.dir.join(RECORD))?;
            }
            None => {}
        }
    }
    if let Err(e) = create(spec, project, base, None, title) {
        if fresh && !spec.dir.join(RECORD).exists() {
            fs::remove_dir_all(&spec.dir)?;
        }
        return Err(e);
    }
    Ok(())
}

/// Home's branch pill [D388, D392]: the checked-out branch, the local branches, and the other worktrees a session
/// can work in. A worktree Brigadier made for a session isn't offered: deleting that session would delete it.
pub fn branches(data: &Path, repo: &Path) -> io::Result<serde_json::Value> {
    let current = git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok();
    let names = git(
        repo,
        &["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"],
    )?;
    let listed = git(repo, &["worktree", "list", "--porcelain"])?;
    let sessions = data
        .canonicalize()
        .unwrap_or_else(|_| data.into())
        .join("sessions");
    // The first entry is the repository's own folder, which is Local checkout's.
    let worktrees: Vec<_> = (listed.split("\n\n").skip(1))
        .filter(|entry| !entry.lines().any(|line| line.starts_with("prunable")))
        .filter_map(|entry| {
            let field = |key: &str| entry.lines().find_map(|line| line.strip_prefix(key));
            let path = field("worktree ")?;
            let branch = field("branch refs/heads/");
            (!Path::new(path).starts_with(&sessions))
                .then(|| serde_json::json!({"path": path, "branch": branch}))
        })
        .collect();
    let branches: Vec<_> = names.lines().collect();
    Ok(serde_json::json!({"current": current, "branches": branches, "worktrees": worktrees}))
}

/// Makes the session's worktree from `base`, else the project's current branch, with its files to copy. A failure undoes what
/// it made; one it can't undo stays recorded for the daemon to retry.
/// `at`: a fork's start, the commit its answer's files were taken on, on `base` [D1068].
pub fn create(
    spec: &Spec,
    project: &projects::Project,
    base: Option<&str>,
    at: Option<&str>,
    title: &str,
) -> io::Result<()> {
    let (repo, picks) = (Path::new(&project.folder), &project.include);
    let _one = lock(&spec.dir)?;
    if read(&spec.dir)?.is_some() {
        return err("This session already has a worktree record.".into());
    }
    let (base_commit, base) = match base {
        // A fork's commit stands in below, whatever became of its base since.
        Some(base) if at.is_some() => (String::new(), base.to_string()),
        // A send as new starts where its source started [D204].
        Some(base) => (
            git(
                repo,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("{base}^{{commit}}"),
                ],
            )
            .or_else(|_| err(format!("{base} isn't in this project any more.")))?,
            base.to_string(),
        ),
        None => {
            let commit = git(repo, &["rev-parse", "--verify", "HEAD"])
                .or_else(|_| err("This project has no commit to start from.".into()))?;
            let name = git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"])
                .unwrap_or(commit.clone());
            (commit, name)
        }
    };
    let base_commit = match at {
        Some(at) => git(
            repo,
            &["rev-parse", "--verify", &format!("{at}^{{commit}}")],
        )?,
        None => base_commit,
    };
    let (_names, branch) = names::reserve(repo, project.branch_prefix.as_deref(), title, None)?;
    if git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok()
    {
        return err(format!("A branch {branch} already exists."));
    }
    crate::worktree_setup::begin(&spec.dir, &branch, &base)?;
    let mut owned = Owned {
        repo: repo.display().to_string(),
        base,
        base_commit,
        failed: true,
        ..Default::default()
    };
    write(&spec.dir, &owned)?;
    let made = make(spec, repo, &branch, picks, &mut owned).and_then(|()| {
        owned.failed = false;
        write(&spec.dir, &owned)
    });
    if let Err(e) = made {
        let step = crate::worktree_setup::finish(&spec.dir, Some(e.to_string()));
        owned.failed = true;
        let recorded = write(&spec.dir, &owned);
        match undo(&owned) {
            Ok(()) => fs::remove_file(spec.dir.join(RECORD))?,
            Err(rollback) => {
                recorded?;
                return err(format!("{e}; rollback failed: {rollback}"));
            }
        }
        step?;
        return Err(e);
    }
    crate::worktree_setup::finish(&spec.dir, None)
}

fn make(
    spec: &Spec,
    repo: &Path,
    branch: &str,
    picks: &[String],
    owned: &mut Owned,
) -> io::Result<()> {
    let path = spec.dir.join("worktree");
    // A failed branch create must never claim a branch another session made.
    git(repo, &["branch", branch, &owned.base_commit])?;
    owned.branch = Some(branch.into());
    write(&spec.dir, owned)?;
    if path.exists() {
        return err(format!("{} already exists", path.display()));
    }
    owned.path = Some(path.display().to_string());
    write(&spec.dir, owned)?;
    let to = path.display().to_string();
    let added = git(repo, &["worktree", "add", "--quiet", &to, branch]);
    owned.admin = git(&path, &["rev-parse", "--path-format=absolute", "--git-dir"]).ok();
    if let Ok(path) = fs::canonicalize(&path) {
        owned.path = Some(path.display().to_string());
    }
    write(&spec.dir, owned)?;
    added?;
    if owned.admin.is_none() {
        return err("Git did not report the worktree's registration.".into());
    }
    include(repo, &path, picks)
}

/// Removes the worktree and its registration, by their recorded paths only.
fn unregister(owned: &Owned) -> io::Result<()> {
    let repo = Path::new(&owned.repo);
    let ours = registration(owned)?;
    if let Some(path) = owned.path.as_deref().filter(|p| Path::new(p).exists()) {
        git(repo, &["worktree", "remove", "--force", path])?;
    }
    if let Some(admin) = owned
        .admin
        .as_deref()
        .filter(|a| ours && Path::new(a).exists())
    {
        fs::remove_dir_all(admin)?;
    }
    Ok(())
}

/// Undoes a create: the worktree, its registration and the branch it made.
fn undo(owned: &Owned) -> io::Result<()> {
    unregister(owned)?;
    let repo = Path::new(&owned.repo);
    if let Some(branch) = &owned.branch
        && git(
            repo,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .is_ok()
    {
        git(repo, &["branch", "-D", branch])?;
    }
    Ok(())
}

/// Whether the branch exists in the repository.
fn has_branch(repo: &Path, branch: &str) -> bool {
    git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok()
}

/// Frees the session's worktree [D180]: its changes are committed to its branch as a checkpoint
/// first, and if that fails nothing is removed and the error says why. Then the worktree and its
/// registration go; the branch and this record stay, for a restore or a delete. The caller holds
/// `lock`.
pub fn free(dir: &Path) -> io::Result<()> {
    let Some(owned) = read(dir)? else {
        return Ok(());
    };
    if let Some(path) = owned.path.as_deref().map(Path::new).filter(|p| p.exists()) {
        let branch = git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
        if Some(&branch) != owned.branch.as_ref() {
            return err("The worktree is on another branch; switch back first.".into());
        }
        git(path, &["add", "-A"])?;
        if !git(path, &["diff", "--cached", "--name-only", "-z"])?.is_empty() {
            git(
                path,
                &[
                    "commit",
                    "--quiet",
                    "--no-verify",
                    "-m",
                    "Brigadier checkpoint",
                ],
            )?;
        }
    }
    unregister(&owned)
}

/// Whether the session's worktree is in place.
pub fn present(dir: &Path) -> bool {
    matches!(read(dir), Ok(Some(o)) if o.path.as_deref().is_some_and(|p| Path::new(p).exists()))
}

/// The session's branch while it exists: Remove project's preview counts the merged ones.
pub fn branch(dir: &Path) -> io::Result<Option<String>> {
    Ok(read(dir)?.and_then(|o| o.branch.filter(|b| has_branch(Path::new(&o.repo), b))))
}

/// Takes a session's worktree away for delete [D35, D181]: freed as above, then its branch goes
/// when its base holds all of it, or when `drop` says so and it's still this session's own. A
/// branch with work that never landed, kept, is returned. The caller holds `lock`.
pub fn delete(dir: &Path, drop: bool) -> io::Result<Option<String>> {
    free(dir)?;
    let Some(owned) = read(dir)? else {
        return Ok(None);
    };
    hand::drop_maker(&owned)?;
    let repo = Path::new(&owned.repo);
    let Some(branch) = owned.branch.clone().filter(|b| has_branch(repo, b)) else {
        return Ok(None);
    };
    if unlanded(dir)?.is_some() && !drop {
        return Ok(Some(branch));
    }
    // Only the branch this session made or was handed, as its record names it, renamed or not
    // [D181, D1080].
    git(repo, &["branch", "-D", &branch])?;
    Ok(None)
}

/// Puts an archived session's worktree back at its path on its branch, with its files to copy
/// [D178, D180, D211]. A failure removes what it added, so restore can run again. The caller
/// holds `lock`.
pub fn restore(dir: &Path, picks: &[String]) -> io::Result<()> {
    let Some(mut owned) = read(dir)? else {
        return Ok(());
    };
    let (Some(branch), Some(path)) = (owned.branch.clone(), owned.path.clone()) else {
        return Ok(());
    };
    if Path::new(&path).exists() {
        return Ok(());
    }
    let repo = PathBuf::from(&owned.repo);
    if !has_branch(&repo, &branch) {
        return err(format!(
            "Its branch {branch} is gone, so its work can't come back."
        ));
    }
    crate::worktree_setup::begin(dir, &branch, &owned.base)?;
    if let Err(e) = git(&repo, &["worktree", "add", "--quiet", &path, &branch]) {
        // A folder may have reappeared since the check: a failed add owns nothing to remove.
        crate::worktree_setup::finish(dir, Some(e.to_string()))?;
        return Err(e);
    }
    owned.admin = git(
        Path::new(&path),
        &["rev-parse", "--path-format=absolute", "--git-dir"],
    )
    .ok();
    let made = write(dir, &owned).and_then(|()| include(&repo, Path::new(&path), picks));
    if let Err(e) = made {
        let step = crate::worktree_setup::finish(dir, Some(e.to_string()));
        unregister(&owned).map_err(|r| io::Error::other(format!("{e}; rollback failed: {r}")))?;
        step?;
        return Err(e);
    }
    crate::worktree_setup::finish(dir, None)
}

/// At the daemon's start: undoes each create that failed and couldn't undo itself, and removes
/// its session once it has; then each archive, restore or delete cut short.
pub fn sweep(data: &Path) {
    for id in ids(data) {
        let dir = session_dir(data, &id);
        let Ok(_one) = lock(&dir) else { continue };
        if let Ok(Some(owned)) = read(&dir)
            && owned.failed
            && undo(&owned).is_ok()
        {
            let _ = fs::remove_dir_all(&dir);
        }
    }
    // Archives, restores and deletes cut short finish or roll back [D35, D180].
    crate::session::sweep(data);
    crate::projects::sweep(data);
}

/// Whether the session has a worktree made in full.
pub(crate) fn made(dir: &Path) -> bool {
    matches!(read(dir), Ok(Some(owned)) if !owned.failed)
}
