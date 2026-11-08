//! A worktree per session [D35, D160, D210]: `sessions/<id>/worktree`, on a new branch
//! `brigadier/<id>` from the project's current branch, with the git-ignored files its
//! `.worktreeinclude` names copied in [D178] and the project's setup script run before the first
//! turn, only in a trusted project [D166, D202, D211]. `worktree.json` records each piece as it's
//! made, so a failed create and a delete remove only what the session owns [D35, D181].

use crate::adapters::setup;
use crate::{Spec, ids, projects, session_dir, write_atomic};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
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

/// One create or delete at a time per session.
fn lock(dir: &Path) -> io::Result<File> {
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

/// Makes the session's worktree from `repo`'s current branch. A failure undoes what it made; one
/// it can't undo stays recorded for the daemon to retry.
pub fn create(spec: &Spec, repo: &Path) -> io::Result<()> {
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
    let made = make(spec, repo, &branch, &mut owned).and_then(|()| {
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

fn make(spec: &Spec, repo: &Path, branch: &str, owned: &mut Owned) -> io::Result<()> {
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
    include(repo, &path)
}

/// Copies the untracked files `.worktreeinclude` names that git also ignores [D178].
/// Links stay links; neither the source nor destination may traverse a linked directory.
fn include(repo: &Path, to: &Path) -> io::Result<()> {
    let rules = repo.join(".worktreeinclude");
    // Git follows a link when it reads the rules: only a regular file is taken.
    if !fs::symlink_metadata(&rules).is_ok_and(|m| m.is_file()) {
        return Ok(());
    }
    let from = format!("--exclude-from={}", rules.display());
    let named = git(repo, &["ls-files", "-z", "--others", "--ignored", &from])?;
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

/// Takes a session's worktree away for delete [D35, D181]: its changes are committed to its
/// branch as a checkpoint first, and if that fails nothing is removed and the error says why.
/// Then the worktree and its registration go, and the branch too when its base holds all of it;
/// a branch with work that never landed stays and is returned.
pub fn delete(dir: &Path) -> io::Result<Option<String>> {
    let _one = lock(dir)?;
    let Some(owned) = read(dir)? else {
        return Ok(None);
    };
    if let Some(path) = owned.path.as_deref().map(Path::new).filter(|p| p.exists()) {
        let branch = git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
        if Some(&branch) != owned.branch.as_ref() {
            return err(
                "The worktree is on another branch; switch back before deleting it.".into(),
            );
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
    unregister(&owned)?;
    let repo = Path::new(&owned.repo);
    let Some(branch) = owned.branch else {
        return Ok(None);
    };
    if git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_err()
    {
        return Ok(None);
    }
    if git(repo, &["merge-base", "--is-ancestor", &branch, &owned.base]).is_ok() {
        git(repo, &["branch", "-D", &branch])?;
        return Ok(None);
    }
    Ok(Some(branch))
}

/// At the daemon's start: undoes each create that failed and couldn't undo itself, and removes
/// its session once it has.
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
}

/// The first launch of a worktree session in a trusted project with a setup script runs the
/// script first, in the worktree, once: its stdin is empty so it can't take the message meant for
/// the agent, its output goes to `setup.log`, and how it ended to `setup.exit`. A failure doesn't
/// stop the agent (proposed). A script started before and never ended was interrupted: it's
/// recorded so and not run again.
pub fn wrap(data: &Path, spec: &Spec, argv: Vec<String>) -> Vec<String> {
    let (started, exit) = (spec.dir.join("setup.started"), spec.dir.join("setup.exit"));
    if !matches!(read(&spec.dir), Ok(Some(owned)) if !owned.failed) || exit.exists() {
        return argv;
    }
    if started.exists() {
        let _ = fs::write(&exit, "interrupted");
        return argv;
    }
    let script = projects::list(data)
        .unwrap_or_default()
        .into_iter()
        .find(|p| Some(&p.id) == spec.project.as_ref())
        .filter(|p| p.trusted == Some(true))
        .map(|p| p.setup)
        .unwrap_or_default();
    if script.trim().is_empty() {
        return argv;
    }
    let path = |name: &str| spec.dir.join(name).display().to_string();
    // The script is an argument of its own, never part of this line.
    let line = r#"if (set -C; : >"$2") 2>/dev/null; then (cd "$5" && /bin/sh -c "$1") </dev/null >"$3" 2>&1; echo $? >"$4"; fi; shift 5; exec "$@""#;
    let head = ["/bin/sh", "-c", line, "sh"].map(String::from);
    let files = [
        script,
        path("setup.started"),
        path("setup.log"),
        path("setup.exit"),
        path("worktree"),
    ];
    head.into_iter().chain(files).chain(argv).collect()
}

/// How the session's setup script went, for its row: null when none ran; else running, done,
/// failed (with its code) or interrupted. `alive` says whether its host's child still runs.
pub fn setup_state(dir: &Path, alive: bool) -> serde_json::Value {
    if !dir.join("setup.started").exists() {
        return serde_json::Value::Null;
    }
    let exit = fs::read_to_string(dir.join("setup.exit")).ok();
    let (state, code) = match exit.as_deref().map(str::trim) {
        None if alive => ("running", None),
        None | Some("interrupted") => ("interrupted", None),
        Some("0") => ("done", Some(0)),
        Some(code) => ("failed", code.parse::<i64>().ok()),
    };
    let tail = (|| -> io::Result<String> {
        let mut log = File::open(dir.join("setup.log"))?;
        let start = log.metadata()?.len().saturating_sub(8192);
        log.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![];
        log.take(8192).read_to_end(&mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })()
    .unwrap_or_default();
    serde_json::json!({"state": state, "code": code, "tail": tail})
}
