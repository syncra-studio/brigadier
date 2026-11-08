//! A worktree per session [D35, D160, D210]: `sessions/<id>/worktree`, on a new branch
//! `brigadier/<id>` from the project's current branch, with the git-ignored files its
//! `.worktreeinclude` names copied in [D178] and the project's setup script run before the first
//! turn, only in a trusted project [D166, D202, D211]. `worktree.json` records each piece as it's
//! made, so a failed create and a delete remove only what the session owns [D35, D181].

use crate::adapters::setup;
pub use crate::worktree_setup::{setup_state, wrap};
use crate::{Spec, ids, projects, session_dir, write_atomic};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

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
}

fn err<T>(message: String) -> io::Result<T> {
    Err(io::Error::other(message))
}

fn git(dir: &Path, args: &[&str]) -> io::Result<String> {
    let mut command = Command::new("git");
    // Bookkeeping must not run a repository's hooks before its trust gate [D166, D211].
    command
        .args(["-c", "core.hooksPath=/dev/null"])
        .arg("-C")
        .arg(dir)
        .args(args);
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
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn write(dir: &Path, owned: &Owned) -> io::Result<()> {
    write_atomic(&dir.join(RECORD), &serde_json::to_vec_pretty(owned)?)
}

/// Where a session's worktree goes.
pub fn path(data: &Path, id: &str) -> PathBuf {
    session_dir(data, id).join("worktree")
}

/// Makes the session's worktree from the project's current branch, with its files to copy. A
/// failure undoes what it made; one it can't undo stays recorded for the daemon to retry.
pub fn create(spec: &Spec, project: &projects::Project) -> io::Result<()> {
    let (repo, picks) = (Path::new(&project.folder), &project.include);
    let _one = lock(&spec.dir)?;
    if read(&spec.dir)?.is_some() {
        return err("This session already has a worktree record.".into());
    }
    let base_commit = git(repo, &["rev-parse", "--verify", "HEAD"])
        .or_else(|_| err("This project has no commit to start from.".into()))?;
    let base =
        git(repo, &["symbolic-ref", "--quiet", "--short", "HEAD"]).unwrap_or(base_commit.clone());
    let branch = format!("brigadier/{}", spec.id);
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
        owned.failed = true;
        let recorded = write(&spec.dir, &owned);
        match undo(&owned) {
            Ok(()) => fs::remove_file(spec.dir.join(RECORD))?,
            Err(rollback) => {
                recorded?;
                return err(format!("{e}; rollback failed: {rollback}"));
            }
        }
        return Err(e);
    }
    Ok(())
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

/// Copies the untracked files that `.worktreeinclude` or the project's picks name and git also
/// ignores [D178, D211]. Links stay links; neither the source nor destination may traverse a
/// linked directory.
fn include(repo: &Path, to: &Path, picks: &[String]) -> io::Result<()> {
    let mut args = names(repo, picks);
    if args.is_empty() {
        return Ok(());
    }
    args.splice(
        0..0,
        ["ls-files", "-z", "--others", "--ignored"].map(String::from),
    );
    let named = git(repo, &args.iter().map(String::as_str).collect::<Vec<_>>())?;
    if named.is_empty() {
        return Ok(());
    }
    let ignored = git(
        repo,
        &[
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-standard",
        ],
    )?;
    let ignored: HashSet<&str> = ignored.split('\0').filter(|p| !p.is_empty()).collect();
    for rel in named.split('\0').filter(|p| ignored.contains(p)) {
        let (src, dst) = (repo.join(rel), to.join(rel));
        let parent = dst.parent().unwrap_or(to);
        let existing = parent.ancestors().find(|p| p.exists()).unwrap_or(to);
        if !fs::canonicalize(existing)?.starts_with(fs::canonicalize(to)?)
            || !fs::canonicalize(src.parent().unwrap_or(repo))?.starts_with(fs::canonicalize(repo)?)
        {
            return err(format!("{rel} leaves the worktree or repository"));
        }
        fs::create_dir_all(parent)?;
        let kind = fs::symlink_metadata(&src)?.file_type();
        if kind.is_symlink() {
            std::os::unix::fs::symlink(fs::read_link(&src)?, &dst)?;
        } else if kind.is_file() {
            fs::copy(&src, &dst)?;
        } else {
            return err(format!("{rel} is not a regular file or a symbolic link"));
        }
    }
    Ok(())
}

/// Git's rules for what's copied: the repo's own `.worktreeinclude`, and each pick anchored at
/// the repository's top. Empty when nothing is.
fn names(repo: &Path, picks: &[String]) -> Vec<String> {
    let rules = repo.join(".worktreeinclude");
    // Git follows a link when it reads the rules: only a regular file is taken.
    let own = fs::symlink_metadata(&rules).is_ok_and(|m| m.is_file());
    let own = own.then(|| format!("--exclude-from={}", rules.display()));
    own.into_iter()
        .chain(picks.iter().map(|p| format!("--exclude=/{p}")))
        .collect()
}

/// What Project settings offers to copy [D178]: the ignored, untracked entries in `dir` (the
/// repository's top for ""), a wholly ignored folder as one entry ending in `/`, at most
/// `MAX_LISTED`; and those the repo's own `.worktreeinclude` already copies.
pub fn ignored(repo: &Path, dir: &str) -> io::Result<(Vec<String>, Vec<String>)> {
    let list = |rules: &str| {
        let mut args = vec![
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--directory",
            rules,
        ];
        if !dir.is_empty() {
            args.extend(["--", dir]);
        }
        let out = git(repo, &args)?;
        let all = out
            .split('\0')
            .filter(|p| !p.is_empty() && p.trim_end_matches('/') != dir.trim_end_matches('/'));
        Ok::<_, io::Error>(all.take(MAX_LISTED).map(String::from).collect::<Vec<_>>())
    };
    let mut entries = list("--exclude-standard")?;
    // A wholly ignored folder lists as itself: its own entries come from the disk.
    if entries.is_empty() && !dir.is_empty() {
        let at = repo.join(dir);
        for entry in fs::read_dir(&at)?.flatten().take(MAX_LISTED) {
            let kind = entry.file_type()?;
            let slash = if kind.is_dir() { "/" } else { "" };
            entries.push(format!(
                "{}/{}{slash}",
                dir.trim_end_matches('/'),
                entry.file_name().to_string_lossy()
            ));
        }
        entries.sort();
    }
    let own = names(repo, &[]);
    let copied = match own.first() {
        Some(rules) => list(rules)?,
        None => vec![],
    };
    Ok((entries, copied))
}

/// Proposed: Project settings lists at most this many entries per folder.
const MAX_LISTED: usize = 300;

/// Removes the worktree and its registration, by their recorded paths only.
fn unregister(owned: &Owned) -> io::Result<()> {
    let repo = Path::new(&owned.repo);
    if let Some(admin) = owned.admin.as_deref().filter(|a| Path::new(a).exists()) {
        let gitdir = fs::read_to_string(Path::new(admin).join("gitdir"))?;
        let expected = owned.path.as_deref().map(|p| Path::new(p).join(".git"));
        if expected.as_deref() != Some(Path::new(gitdir.trim_end_matches('\n'))) {
            return err("The worktree's registration now belongs to another checkout.".into());
        }
    }
    if let Some(path) = owned.path.as_deref().filter(|p| Path::new(p).exists()) {
        git(repo, &["worktree", "remove", "--force", path])?;
    }
    if let Some(admin) = owned.admin.as_deref().filter(|a| Path::new(a).exists()) {
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
    let landed = git(repo, &["merge-base", "--is-ancestor", &branch, &owned.base]).is_ok();
    Ok((dirty || !landed).then_some(branch))
}

/// Takes a session's worktree away for delete [D35, D181]: freed as above, then its branch goes
/// when its base holds all of it, or when `drop` says so and it's still this session's own. A
/// branch with work that never landed, kept, is returned. The caller holds `lock`.
pub fn delete(dir: &Path, drop: bool) -> io::Result<Option<String>> {
    free(dir)?;
    let Some(owned) = read(dir)? else {
        return Ok(None);
    };
    let repo = Path::new(&owned.repo);
    let Some(branch) = owned.branch.filter(|b| has_branch(repo, b)) else {
        return Ok(None);
    };
    if unlanded(dir)?.is_some() && !drop {
        return Ok(Some(branch));
    }
    // Re-checked as it runs: only the branch this session made, named for it [D181].
    let id = dir.file_name().map(|n| n.to_string_lossy().into_owned());
    if Some(branch.as_str()) != id.map(|id| format!("brigadier/{id}")).as_deref() {
        return err(format!(
            "The branch {branch} isn't this session's own; it stays."
        ));
    }
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
    let added = git(&repo, &["worktree", "add", "--quiet", &path, &branch]);
    owned.admin = git(
        Path::new(&path),
        &["rev-parse", "--path-format=absolute", "--git-dir"],
    )
    .ok();
    let made = added
        .and_then(|_| write(dir, &owned))
        .and_then(|()| include(&repo, Path::new(&path), picks));
    if let Err(e) = made {
        unregister(&owned).map_err(|r| io::Error::other(format!("{e}; rollback failed: {r}")))?;
        return Err(e);
    }
    Ok(())
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
}

/// Whether the session has a worktree made in full.
pub(crate) fn made(dir: &Path) -> bool {
    matches!(read(dir), Ok(Some(owned)) if !owned.failed)
}
