//! Projects [D165, D171]: Brigadier's own record of each repository sessions run in, kept in
//! `projects.json` in the data folder (proposed). Later steps only add fields: the trust answer's
//! use (1h), worktrees (1l), project settings (1r).

use crate::adapters::{home_path, setup};
use crate::{Spec, check_id, ids, load, write_atomic};
use brigadier_frames::log::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Proposed: a name is at most this many characters.
const NAME_CHARS: usize = 80;
/// Proposed: a git that hangs (a stalled network folder) never holds up an add.
const GIT_SECS: u64 = 5;

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(default)]
pub struct Project {
    pub id: String,
    pub name: String,
    /// The top folder of the repository's main checkout, canonical.
    pub folder: String,
    /// None until the owner answers "Trust this folder?" [D166, D167].
    pub trusted: Option<bool>,
    /// Runs before the first turn in a new worktree, only while trusted [D202, D211].
    pub setup: String,
    /// Ignored files copied into each new worktree, beside the repo's own `.worktreeinclude`:
    /// paths from the repository's top [D178, D211].
    pub include: Vec<String>,
    pub added: u64,
    /// Set while Remove project runs: its sessions take no new work [D172, D179].
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub removing: bool,
    /// Prefix for new session branches; absent uses brigadier/ [D1214].
    pub branch_prefix: Option<String>,
    /// The GitHub login its PRs and sessions use; None: the one that can see it [D631].
    pub github_account: Option<String>,
    /// The browser profile its sessions' tabs open on; None: the default one [D769].
    pub browser_profile: Option<String>,
    /// "folder": a folder of repositories, added as is [D494]; empty: one repository.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub kind: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Records {
    projects: Vec<Project>,
}

fn err<T>(message: String) -> io::Result<T> {
    Err(io::Error::other(message))
}

fn read(data: &Path) -> io::Result<Option<Vec<Project>>> {
    match fs::read(data.join("projects.json")) {
        Ok(bytes) => Ok(Some(serde_json::from_slice::<Records>(&bytes)?.projects)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Every project, oldest first. The first read moves `profile.json`'s plain paths over, once.
pub fn list(data: &Path) -> io::Result<Vec<Project>> {
    match read(data)? {
        Some(list) => Ok(list),
        None => locked(data).map(|(_, list)| list),
    }
}

/// Holds `projects.lock` with the current records, migrating once if needed. A session start
/// holds it through project validation and writing its record, never through starting the host.
pub fn locked(data: &Path) -> io::Result<(fs::File, Vec<Project>)> {
    fs::create_dir_all(data)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data.join("projects.lock"))?;
    lock.lock()?;
    let list = match read(data)? {
        Some(list) => list,
        None => {
            let list = migrated(data);
            write(data, &list)?;
            list
        }
    };
    Ok((lock, list))
}

fn write(data: &Path, list: &[Project]) -> io::Result<()> {
    let records = serde_json::to_vec_pretty(&Records {
        projects: list.to_vec(),
    })?;
    write_atomic(&data.join("projects.json"), &records)
}

/// Changes the records under `projects.lock`, so the CLI and the daemon never lose each other's
/// writes, and writes them; returns the list and what `f` gave.
fn change<T>(
    data: &Path,
    f: impl FnOnce(&mut Vec<Project>) -> io::Result<T>,
) -> io::Result<(Vec<Project>, T)> {
    let (_lock, mut list) = locked(data)?;
    let out = f(&mut list)?;
    write(data, &list)?;
    Ok((list, out))
}

/// Waits for and takes the data folder's lock `name`, held until the file is dropped.
pub fn lock(data: &Path, name: &str) -> io::Result<fs::File> {
    fs::create_dir_all(data)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data.join(name))?;
    lock.lock()?;
    Ok(lock)
}

/// `profile.json`'s plain paths as records (proposed): each resolved to its main checkout, or
/// kept as it was when git can't, so no project silently goes.
fn migrated(data: &Path) -> Vec<Project> {
    let profile: Value = fs::read(data.join("profile.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let now = now_ms();
    let mut list: Vec<Project> = vec![];
    for path in profile["projects"].as_array().into_iter().flatten() {
        let Some(path) = path.as_str().map(Path::new) else {
            continue;
        };
        let folder = root(path).unwrap_or_else(|| path.to_path_buf());
        let folder = folder.display().to_string();
        if !list.iter().any(|p| p.folder == folder) {
            let id = format!("p-{now:x}-{}", list.len());
            list.push(record(id, &folder, None, now));
        }
    }
    list
}

fn record(id: String, folder: &str, name: Option<&str>, added: u64) -> Project {
    let base = Path::new(folder).file_name().map(|n| n.to_string_lossy());
    let name = name.map_or_else(|| base.unwrap_or_default().into_owned(), String::from);
    Project {
        id,
        name,
        folder: folder.into(),
        added,
        ..Default::default()
    }
}

fn clean(name: &str) -> io::Result<String> {
    let name: String = name.trim().chars().take(NAME_CHARS).collect();
    if name.is_empty() {
        return err("A project needs a name.".into());
    }
    Ok(name)
}

/// The top folder of the main checkout of the repository `dir` is in, canonical: a linked
/// worktree gives its main checkout's, so every worktree of one repository is one project.
pub fn root(dir: &Path) -> Option<PathBuf> {
    let git = |args: &[&str]| {
        let mut command = Command::new("git");
        command.arg("-C").arg(dir).args(args);
        let out = setup::run(&mut command, GIT_SECS).ok()?;
        out.status.success().then_some(out.stdout)
    };
    let top = git(&["rev-parse", "--show-toplevel"])?;
    let top = String::from_utf8_lossy(&top)
        .trim_end_matches('\n')
        .to_string();
    // The first entry is the main checkout, unless the repository is bare.
    let worktrees = git(&["worktree", "list", "--porcelain", "-z"]).unwrap_or_default();
    let worktrees = String::from_utf8_lossy(&worktrees);
    let first: Vec<&str> = worktrees
        .split('\0')
        .take_while(|f| !f.is_empty())
        .collect();
    let main = first
        .first()
        .and_then(|f| f.strip_prefix("worktree "))
        .filter(|_| !first.contains(&"bare"));
    fs::canonicalize(main.unwrap_or(&top)).ok()
}

/// Refuses a folder no project may be in: Brigadier's own data folder or one inside it.
fn own(data: &Path, dir: &Path) -> io::Result<()> {
    if fs::canonicalize(data).is_ok_and(|d| dir.starts_with(d)) {
        return err("That folder belongs to Brigadier itself.".into());
    }
    Ok(())
}

/// The guards for a folder that isn't a repository yet, as the old app had them: Brigadier's own
/// folder, and the home folder or one above it. For making or cloning one there (1g).
pub fn plain(data: &Path, dir: &Path) -> io::Result<()> {
    let dir = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    own(data, &dir)?;
    let home = fs::canonicalize(home_path("")).unwrap_or_else(|_| home_path(""));
    if home.starts_with(&dir) {
        return err("Brigadier won't make a repository of your home folder or a folder above it. Choose a folder inside it.".into());
    }
    Ok(())
}

/// What adding `path` would add: its repository's main checkout, after every guard. Writes
/// nothing, so a step can ask before it touches the disk.
pub fn check(data: &Path, path: &str) -> io::Result<PathBuf> {
    let folder = repo(data, path)?;
    taken(&list(data)?, &folder)?;
    Ok(folder)
}

/// The main checkout `path` is in, after every guard but "already a project".
fn repo(data: &Path, path: &str) -> io::Result<PathBuf> {
    match fs::metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return err(format!("{path} does not exist"));
        }
        Err(e) => return err(format!("{path}: {e}")),
        Ok(m) if !m.is_dir() => return err("That's a file. Choose a folder.".into()),
        Ok(_) => {}
    }
    let Some(folder) = root(Path::new(path)) else {
        plain(data, Path::new(path))?;
        // A folder holding repositories is added as it is, one project [D494].
        let folder = fs::canonicalize(path)?;
        if crate::folder::repos(&folder).is_empty() {
            return err(format!("{path} is not in a git repository"));
        }
        own(data, &folder)?;
        return Ok(folder);
    };
    own(data, &folder)?;
    Ok(folder)
}

fn taken(list: &[Project], folder: &Path) -> io::Result<()> {
    match list.iter().find(|p| Path::new(&p.folder) == folder) {
        Some(p) => err(format!(
            "{} is already the project \"{}\"",
            p.folder, p.name
        )),
        None => Ok(()),
    }
}

/// Adds the repository `path` is in, under `id` when the app made one to show it at once [D30].
pub fn add(data: &Path, path: &str, id: Option<&str>, name: Option<&str>) -> io::Result<Project> {
    let folder = check(data, path)?;
    let kind = crate::folder::kind(&folder);
    let name = name.map(clean).transpose()?;
    let added = now_ms();
    let id = id.map_or_else(|| format!("p-{added:x}"), String::from);
    check_id(&id).or_else(|_| err(format!("invalid project id {id:?}")))?;
    let (_, project) = change(data, |list| {
        // Checked again under the lock: another add may have landed since.
        taken(list, &folder)?;
        if list.iter().any(|p| p.id == id) {
            return err(format!("project id {id} is taken"));
        }
        let folder = folder.display().to_string();
        list.push(Project {
            kind,
            ..record(id, &folder, name.as_deref(), added)
        });
        Ok(list.last().unwrap().clone())
    })?;
    Ok(project)
}

fn find<'a>(list: &'a mut [Project], id: &str) -> io::Result<&'a mut Project> {
    match list.iter_mut().find(|p| p.id == id) {
        Some(p) => Ok(p),
        None => err(format!("no project {id}")),
    }
}

pub fn get(data: &Path, id: &str) -> io::Result<Project> {
    let mut list = list(data)?;
    find(&mut list, id).cloned()
}

/// What `set` changes; None leaves a field as it is.
#[derive(Default)]
pub struct Change {
    pub branch_prefix: Option<String>,
    pub name: Option<String>,
    pub folder: Option<String>,
    pub trusted: Option<Option<bool>>,
    pub setup: Option<String>,
    pub include: Option<Vec<String>>,
    pub github_account: Option<Option<String>>,
    pub browser_profile: Option<Option<String>>,
}

/// Changes a project's settings [D171]. A new folder resets its trust, so it's asked again, and is
/// refused while the project has sessions (proposed), so trust never moves under them [D166].
/// Every trust change goes through here; its caller then syncs the CLIs' own entries (1i).
pub fn set(data: &Path, id: &str, new: Change) -> io::Result<Project> {
    let name = new.name.as_deref().map(clean).transpose()?;
    if let Some(prefix) = &new.branch_prefix {
        crate::worktrees::names::check_prefix(prefix)?;
    }
    let bad = |c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if let Some(Some(login)) = &new.github_account
        && (login.starts_with('-') || login.contains(bad))
    {
        return err(format!("\"{login}\" isn't a GitHub login."));
    }
    let folder = new.folder.map(|f| repo(data, &f)).transpose()?;
    let include = new
        .include
        .map(|paths| {
            paths
                .iter()
                .map(|p| path(p))
                .collect::<io::Result<Vec<_>>>()
        })
        .transpose()?;
    let count = folder
        .as_ref()
        .map_or(Ok(0), |_| sessions(data, id).map(|s| s.len()))?;
    let (_, project) = change(data, |list| {
        let now = find(list, id)?.folder.clone();
        if let Some(folder) = folder.filter(|f| Path::new(&now) != f) {
            taken(list, &folder)?;
            let p = find(list, id)?;
            if count > 0 {
                let sessions = if count == 1 { "session" } else { "sessions" };
                return err(format!(
                    "\"{}\" has {count} {sessions}, so its folder can't change.",
                    p.name
                ));
            }
            p.folder = folder.display().to_string();
            p.kind = crate::folder::kind(&folder);
            p.trusted = None;
        }
        let p = find(list, id)?;
        if let Some(prefix) = new.branch_prefix {
            p.branch_prefix = Some(prefix);
        }
        if let Some(name) = name {
            p.name = name;
        }
        if let Some(trusted) = new.trusted {
            p.trusted = trusted;
        }
        if let Some(setup) = new.setup {
            p.setup = setup;
        }
        if let Some(include) = include {
            p.include = include;
        }
        if let Some(account) = new.github_account {
            p.github_account = account;
        }
        if let Some(profile) = new.browser_profile {
            p.browser_profile = profile;
        }
        Ok(p.clone())
    })?;
    Ok(project)
}

/// One path to copy into worktrees, from the repository's top; never out of it.
fn path(p: &str) -> io::Result<String> {
    let p = p.trim().trim_end_matches('/');
    if p.is_empty() {
        return err("A file to copy can't be empty.".into());
    }
    if p.starts_with('/') || p.starts_with('~') {
        return err(format!("\"{p}\" must be relative to the repository root."));
    }
    if p.split('/').any(|part| part == "..") {
        return err(format!("\"{p}\" must stay inside the repository."));
    }
    Ok(p.into())
}

/// The project's sessions, archived ones too.
pub fn sessions(data: &Path, id: &str) -> io::Result<Vec<String>> {
    let projects = list(data)?;
    let mut roots = Roots::default();
    Ok(ids(data)
        .into_iter()
        .filter(|s| {
            load(data, s).is_ok_and(|spec| of(&spec, &projects, &mut roots).as_deref() == Some(id))
        })
        .collect())
}

/// Marks the project as being removed, or clears it; a second Remove while one runs is refused.
pub fn set_removing(data: &Path, id: &str, on: bool) -> io::Result<()> {
    change(data, |list| {
        let p = find(list, id)?;
        if on && p.removing {
            return err(format!("\"{}\" is already being removed.", p.name));
        }
        p.removing = on;
        Ok(())
    })?;
    Ok(())
}

/// Removes the record once the project has no sessions left, checked under `projects.lock`, so
/// one started meanwhile keeps it [D172, D179]. Sessions go first, through Remove project (1w);
/// stream decision D1's refusal is lifted there.
pub fn remove(data: &Path, id: &str) -> io::Result<()> {
    change(data, |list| {
        let name = find(list, id)?.name.clone();
        let mut roots = Roots::default();
        let left = ids(data)
            .iter()
            .filter_map(|s| load(data, s).ok())
            .filter(|spec| of(spec, list, &mut roots).as_deref() == Some(id))
            .count();
        if left > 0 {
            return err(format!("\"{name}\" still has {left} session(s)."));
        }
        list.retain(|p| p.id != id);
        Ok(())
    })?;
    // Its folder goes with it: what its tabs read before a session there started [D279].
    match fs::remove_dir_all(dir(data, id)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// A project's own folder, at this exact path, removed with the project [D35, D279].
pub fn dir(data: &Path, id: &str) -> PathBuf {
    data.join("projects").join(id)
}

/// At the daemon's start: a Remove project cut short frees its project for new work again; its
/// sessions' recorded deletes retry on their own (1v).
pub fn sweep(data: &Path) {
    if list(data).is_ok_and(|l| l.iter().any(|p| p.removing)) {
        let _ = change(data, |list| {
            list.iter_mut().for_each(|p| p.removing = false);
            Ok(())
        });
    }
}

/// Each session folder's repository, by its cwd, so a list asks git once per folder.
pub type Roots = std::collections::HashMap<String, Option<String>>;

/// The project a session is in: the one it was started in, or, for one started without
/// (before 1a, or from the CLI with only a folder), the project whose main checkout its folder
/// belongs to (proposed). Reads only; `session.json` is never written.
pub fn of(spec: &Spec, projects: &[Project], roots: &mut Roots) -> Option<String> {
    if spec.project.is_some() {
        return spec.project.clone();
    }
    let found = roots
        .entry(spec.cwd.clone())
        .or_insert_with(|| root(Path::new(&spec.cwd)).map(|r| r.display().to_string()));
    let found = found.as_deref()?;
    projects
        .iter()
        .find(|p| p.folder == found)
        .map(|p| p.id.clone())
}

/// Whether a session's turns are held to Ask: its project is untrusted or unanswered [D166]. A
/// session in no project isn't (proposed); records that can't be read hold it.
pub fn held(data: &Path, spec: &Spec) -> bool {
    let Ok(projects) = list(data) else {
        return true;
    };
    let id = of(spec, &projects, &mut Roots::default());
    projects
        .iter()
        .any(|p| Some(&p.id) == id.as_ref() && p.trusted != Some(true))
}

/// Whether the session's project is being removed: no new work starts in it then [D172].
pub fn removing(data: &Path, spec: &Spec) -> bool {
    let Ok(projects) = list(data) else {
        return false;
    };
    let id = of(spec, &projects, &mut Roots::default());
    projects
        .iter()
        .any(|p| Some(&p.id) == id.as_ref() && p.removing)
}
