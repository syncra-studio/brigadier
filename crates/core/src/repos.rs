//! Add project's sources [D165, D168, D202]: the repositories on this Mac, what a chosen folder
//! is, a clone, a new repository, and your GitHub repositories through gh. Every add goes through
//! `projects::add` under the id the app made, and every guard runs before anything is made.

use crate::adapters::{self, home_path, setup};
use crate::{check_id, projects};
use serde_json::{Value, json};
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

/// The home folder's usual code folders, looked through two levels deep (the old app's list).
const CODE_FOLDERS: &[&str] = &[
    "code",
    "Code",
    "Development",
    "Developer",
    "dev",
    "Projects",
    "projects",
    "src",
    "repos",
    "git",
    "GitHub",
    "workspace",
    "work",
    "Sites",
];
const CODE_DEPTH: usize = 2;
/// One look reads at most this many folders, for at most this long, and lists this many repositories.
const MAX_FOLDERS: usize = 4000;
const LOOK_BUDGET: Duration = Duration::from_millis(1500);
const MAX_REPOS: usize = 300;
/// Never looked into: packages and build output.
const SKIPPED: &[&str] = &["node_modules", "target", "vendor"];
/// Home folders macOS asks the user about before an app reads them, and the system's own: never
/// touched, so opening the dialog never raises a prompt.
const PROTECTED: &[&str] = &[
    "Desktop",
    "Documents",
    "Downloads",
    "Library",
    "Pictures",
    "Movies",
    "Music",
    "Applications",
];
/// Proposed: a clone gets an hour, git init and its first commit 20 s.
const CLONE_SECS: u64 = 3600;
const INIT_SECS: u64 = 20;

fn err<T>(message: impl Into<String>) -> io::Result<T> {
    Err(io::Error::other(message.into()))
}

/// `~/x` as the home folder's `x`; anything else as typed.
fn expand(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home_path(rest),
        None if path == "~" => home_path(""),
        None => PathBuf::from(path),
    }
}

/// A command on the login shell's PATH, never asking for a password: it fails instead.
pub(crate) fn tool(bin: &str) -> Command {
    let mut command = Command::new(bin);
    command
        .env("PATH", setup::login().path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never");
    command
}

/// What a tool said on failure, in its own words without blank lines or `fatal: `; or how it ended.
pub(crate) fn failed(out: &Output) -> String {
    let text = String::from_utf8_lossy(&out.stderr);
    let lines: Vec<&str> = text
        .lines()
        .map(|l| l.trim().trim_start_matches("fatal: "))
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        out.status.to_string()
    } else {
        lines.join("\n")
    }
}

fn ran(command: &mut Command, secs: u64) -> io::Result<()> {
    let out = setup::run(command, secs).map_err(io::Error::other)?;
    if out.status.success() {
        Ok(())
    } else {
        err(failed(&out))
    }
}

/// Whether a folder is in one macOS asks the user about (or the system's own): looking at it, even
/// to check it is a repository, raises a prompt.
pub fn protected(home: &Path, path: &Path) -> bool {
    PROTECTED.iter().any(|f| path.starts_with(home.join(f)))
}

/// When a repository was last worked in: its index's or HEAD's last change.
fn used_ms(repo: &Path) -> u64 {
    let modified = |f: &str| {
        fs::metadata(repo.join(".git").join(f))
            .and_then(|m| m.modified())
            .ok()
    };
    let at = modified("index").max(modified("HEAD"));
    at.and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// The repositories on this Mac, most recent first [D165]: where the agents' sessions ran, the
/// folders beside those, and a bounded look through the usual code folders, so a Mac with no CLI
/// history still lists some. Each comes with its project's id once it is one.
pub fn find(data: &Path) -> io::Result<Vec<Value>> {
    let home = fs::canonicalize(home_path("")).unwrap_or_else(|_| home_path(""));
    let data_dir = fs::canonicalize(data).unwrap_or_else(|_| data.to_path_buf());
    let usable = |p: &Path| !p.starts_with(&data_dir) && !protected(&home, p);
    let history: Vec<PathBuf> = thread::scope(|s| {
        let all = adapters::all().map(|a| s.spawn(move || a.projects()));
        all.into_iter()
            .flat_map(|t| t.join().unwrap_or_default())
            .collect()
    });
    let mut found: Vec<PathBuf> = vec![];
    let mut looks: VecDeque<(PathBuf, usize)> = VecDeque::new();
    for cwd in history.iter().filter(|p| usable(p)) {
        // A linked worktree's `.git` is a file: its main checkout is found on its own.
        if let Some(repo) = setup::repo(cwd).filter(|r| r.join(".git").is_dir()) {
            looks.extend(repo.parent().map(|p| (p.to_path_buf(), 1)));
            found.push(repo);
        }
    }
    looks.push_back((home.clone(), 1));
    looks.extend(CODE_FOLDERS.iter().map(|f| (home.join(f), CODE_DEPTH)));
    // Breadth first, so every shallow folder is seen before a deep one spends the budget.
    let deadline = Instant::now() + LOOK_BUDGET;
    let (mut seen, mut read) = (HashSet::new(), 0);
    while let Some((dir, depth)) = looks.pop_front() {
        if read >= MAX_FOLDERS || Instant::now() >= deadline {
            break;
        }
        // `~/code` and `~/Code` are one folder on a case-insensitive disk.
        let Ok(dir) = fs::canonicalize(&dir) else {
            continue;
        };
        if !usable(&dir) || !seen.insert(dir.clone()) {
            continue;
        }
        read += 1;
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            // Links are passed over, so a look never leaves the folders it was given.
            if name.starts_with('.')
                || SKIPPED.contains(&name.as_ref())
                || !entry.file_type().is_ok_and(|t| t.is_dir())
            {
                continue;
            }
            let path = entry.path();
            if path.join(".git").is_dir() {
                found.push(path);
            } else if depth > 1 {
                looks.push_back((path, depth - 1));
            }
        }
    }
    let projects = projects::list(data)?;
    let mut unique = HashSet::new();
    let mut repos: Vec<(u64, PathBuf)> = found
        .into_iter()
        .filter_map(|p| fs::canonicalize(&p).ok())
        .filter(|p| usable(p) && unique.insert(p.clone()))
        .map(|p| (used_ms(&p), p))
        .collect();
    repos.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    repos.truncate(MAX_REPOS);
    Ok(repos
        .into_iter()
        .map(|(used, path)| {
            let path = path.display().to_string();
            let project = projects
                .iter()
                .find(|p| p.folder == path)
                .map(|p| p.id.clone());
            let name = Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned());
            json!({"path": path, "name": name, "used": used, "project_id": project})
        })
        .collect())
}

/// What a chosen folder is: a repository (and its project, if added), a folder in none, a
/// missing path (New repository then offers to make it), or why it can't be one. Writes nothing.
pub fn inspect(data: &Path, path: &str) -> io::Result<Value> {
    let dir = expand(path);
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned());
    let invalid = |e: io::Error| json!({"kind": "invalid", "reason": e.to_string()});
    if !dir.is_absolute() {
        return Ok(
            json!({"kind": "invalid", "reason": "Type the folder's full path, like ~/code/app."}),
        );
    }
    if !dir.exists() {
        return Ok(json!({"kind": "missing", "path": dir}));
    }
    let Some(repo) = projects::root(&dir) else {
        let plain = fs::metadata(&dir)
            .is_ok_and(|m| m.is_dir())
            .then_some(())
            .ok_or_else(|| io::Error::other("That's a file. Choose a folder."));
        // A folder of repos is added as it is, one project [D494].
        let repos = crate::folder::repos(&dir);
        return Ok(match plain.and_then(|()| projects::plain(data, &dir)) {
            Ok(()) if !repos.is_empty() => {
                let folder = fs::canonicalize(&dir)?.display().to_string();
                let added = projects::list(data)?
                    .into_iter()
                    .find(|p| p.folder == folder);
                json!({"kind": "folder", "path": dir, "name": added.as_ref().map_or(name, |p| Some(p.name.clone())),
                    "repos": repos, "project_id": added.map(|p| p.id)})
            }
            Ok(()) => json!({"kind": "plain", "path": dir, "name": name}),
            Err(e) => invalid(e),
        });
    };
    let folder = repo.display().to_string();
    if let Some(p) = projects::list(data)?
        .into_iter()
        .find(|p| p.folder == folder)
    {
        return Ok(json!({"kind": "repo", "repo": folder, "name": p.name, "project_id": p.id}));
    }
    Ok(match projects::check(data, &dir.to_string_lossy()) {
        Ok(repo) => {
            let name = repo.file_name().map(|n| n.to_string_lossy().into_owned());
            json!({"kind": "repo", "repo": repo, "name": name, "project_id": null})
        }
        Err(e) => invalid(e),
    })
}

/// A folder a clone or new repository may go to, checked before anything is made: the id, the
/// name, Brigadier's own folder and the home folder (`projects::plain`). With `empty_ok`, an
/// empty folder that is in no repository will do; otherwise only a missing one.
fn destination(data: &Path, id: &str, dest: &str, empty_ok: bool) -> io::Result<PathBuf> {
    check_id(id).or_else(|_| err(format!("invalid project id {id:?}")))?;
    let dir = expand(dest.trim());
    if !dir.is_absolute() {
        return err("Type the full path of the folder to clone into.");
    }
    match dir.file_name().map(|n| n.to_string_lossy()) {
        Some(n) if n != "." && n != ".." => {}
        _ => return err(format!("\"{}\" can't be a folder name", dir.display())),
    }
    projects::plain(data, &dir)?;
    if dir.exists() {
        let empty = fs::read_dir(&dir).is_ok_and(|mut d| d.next().is_none());
        if !empty_ok || !empty || projects::root(&dir).is_some() {
            return err(format!(
                "{} already exists. Choose another folder name.",
                dir.display()
            ));
        }
    }
    Ok(dir)
}

/// Clones `from` into `dest` and adds it under `id`: a URL with git itself, or with `github` an
/// `owner/name` through gh, which uses gh's own sign-in and protocol, or `account`'s [D168, D202,
/// D631]. Neither ever asks for a password; git's reason comes back instead.
pub fn clone(
    data: &Path,
    from: &str,
    dest: &str,
    github: bool,
    account: Option<&str>,
    id: &str,
) -> io::Result<projects::Project> {
    let from = from.trim();
    if from.is_empty() {
        return err("Paste the repository's URL.");
    }
    if from.starts_with('-') {
        return err(format!("{from} is not a repository URL"));
    }
    let dir = destination(data, id, dest, false)?;
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent)?;
    }
    let cloned = if github {
        crate::host::clone_github(from, &dir, CLONE_SECS, account)
    } else {
        ran(
            tool("git").args(["clone", "--quiet", "--", from]).arg(&dir),
            CLONE_SECS,
        )
    };
    if let Err(e) = cloned {
        // A clone that failed part way leaves nothing behind.
        let _ = fs::remove_dir_all(&dir);
        let reason = e.to_string().to_lowercase();
        if reason.contains("repository not found")
            || (reason.contains("repository ") && reason.contains(" not found"))
            || reason.contains("could not read username")
            || reason.contains("could not read password")
            || reason.contains("authentication failed")
            || reason.contains("permission denied (publickey")
        {
            return err("The repository wasn't found, or you don't have access to it.");
        }
        return Err(e);
    }
    let project = projects::add(data, &dir.display().to_string(), Some(id), None)?;
    // The account it was cloned as is its pick, so its PRs and sessions act as it too [D631].
    match account {
        Some(login) => {
            let change = projects::Change {
                github_account: Some(Some(login.into())),
                ..Default::default()
            };
            projects::set(data, &project.id, change)
        }
        None => Ok(project),
    }
}

/// Makes a new repository at `dest` and adds it under `id`: the folder, `git init` and an empty
/// first commit, so sessions have a branch to start from. When git can't commit (no name or email,
/// a signing key that asks), whatever this made goes and git's reason comes back. With `here`,
/// `dest` is an existing folder in no repository (Add project's "Not a repository" row).
pub fn init(data: &Path, dest: &str, here: bool, id: &str) -> io::Result<projects::Project> {
    let dir = if here {
        check_id(id).or_else(|_| err(format!("invalid project id {id:?}")))?;
        let dir = expand(dest);
        if !dir.is_dir() || projects::root(&dir).is_some() {
            return err(format!(
                "{} isn't a folder outside a repository",
                dir.display()
            ));
        }
        projects::plain(data, &dir)?;
        dir
    } else {
        destination(data, id, dest, true)?
    };
    let made = !dir.exists();
    fs::create_dir_all(&dir)?;
    let commit = ran(
        tool("git").arg("-C").arg(&dir).args(["init", "--quiet"]),
        INIT_SECS,
    )
    .and_then(|()| {
        ran(
            tool("git").arg("-C").arg(&dir).args([
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "Initial commit",
            ]),
            INIT_SECS,
        )
    });
    if let Err(e) = commit {
        let _ = if made {
            fs::remove_dir_all(&dir)
        } else {
            fs::remove_dir_all(dir.join(".git"))
        };
        return Err(e);
    }
    projects::add(data, &dir.display().to_string(), Some(id), None)
}
