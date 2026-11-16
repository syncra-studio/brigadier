//! A folder of repositories added as one project, as it is [D490, D494]: the agent gets a map, one
//! line per repository, and claims a repository with `brigadier repo <name>` before its first
//! change there, which makes that repository's branch and worktree for this session only.

use crate::{Spec, data_of, projects, worktrees};
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const KIND: &str = "folder";
/// Above this many repositories the map goes to `REPOS.md`, out of every turn [D494].
const INLINE: usize = 80;
/// A description's most characters.
const LINE: usize = 100;
/// The trigger, its bytes held by `scripts/limits` [D529, D544].
const RULE: &str = include_str!("standing/repos.txt");

fn err<T>(message: impl Into<String>) -> io::Result<T> {
    Err(io::Error::other(message.into()))
}

/// A new session's checkout: a folder chat's own empty folder, where the repos it claims go
/// [D494], else its worktree (`worktrees::ensure`).
pub fn ensure(
    spec: &Spec,
    project: &projects::Project,
    fresh: bool,
    base: Option<&str>,
    title: &str,
) -> io::Result<()> {
    match project.kind == KIND {
        true => fs::create_dir_all(&spec.cwd),
        false => worktrees::ensure(spec, project, fresh, base, title),
    }
}

/// A project folder's kind: `KIND` for one that is no repository itself, else none.
pub fn kind(folder: &Path) -> String {
    match projects::root(folder) {
        None => KIND.into(),
        Some(_) => String::new(),
    }
}

/// The folder project a session is in, if it is in one.
pub fn of(spec: &Spec) -> Option<projects::Project> {
    let p = projects::get(&data_of(spec), spec.project.as_deref()?).ok()?;
    (p.kind == KIND).then_some(p)
}

/// The repositories in `home`, each named by its path from there: a folder holding `.git`, up to
/// two levels down, past dot folders and `node_modules`, never inside another repository.
pub fn repos(home: &Path) -> Vec<String> {
    fn walk(dir: &Path, prefix: &str, depth: u8, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.')
                || name == "node_modules"
                || !e.file_type().is_ok_and(|t| t.is_dir())
            {
                continue;
            }
            let rel = match prefix {
                "" => name,
                p => format!("{p}/{name}"),
            };
            if e.path().join(".git").exists() {
                out.push(rel);
            } else if depth > 1 {
                walk(&e.path(), &rel, depth - 1, out);
            }
        }
    }
    let mut out = vec![];
    walk(home, "", 2, &mut out);
    out.sort();
    out
}

/// What a repository is, in one line: its package's description, else its README's first sentence.
fn described(repo: &Path) -> String {
    let read = |f: &str| fs::read_to_string(repo.join(f)).unwrap_or_default();
    let package = serde_json::from_str::<Value>(&read("package.json")).unwrap_or_default();
    let toml = ["Cargo.toml", "pyproject.toml"].iter().find_map(|f| {
        read(f).lines().find_map(|l| {
            let (k, v) = l.split_once('=')?;
            (k.trim() == "description").then(|| v.trim().trim_matches(['"', '\'']).to_string())
        })
    });
    let readme = || {
        let text = ["README.md", "readme.md", "README"].map(read).concat();
        let line = text.lines().map(str::trim).find(|l| {
            !l.is_empty() && !l.starts_with(['#', '!', '[', '<', '=', '-', '|', '`', '>'])
        });
        let line = line.unwrap_or_default();
        line.split_once(". ").map_or(line, |(s, _)| s).to_string()
    };
    let words = (package["description"].as_str().map(String::from))
        .filter(|d| !d.trim().is_empty())
        .or(toml.filter(|d| !d.is_empty()))
        .unwrap_or_else(readme);
    let words = words.split_whitespace().collect::<Vec<_>>().join(" ");
    match words.chars().count() > LINE {
        true => format!("{}…", words.chars().take(LINE - 1).collect::<String>()),
        false => words,
    }
}

/// A folder chat's part of the standing text: the trigger, then the map inline, or past `INLINE`
/// repositories a pointer to `REPOS.md` in its session folder. None outside a folder project.
pub fn standing(spec: &Spec) -> Option<String> {
    let home = PathBuf::from(of(spec)?.folder);
    let names = repos(&home);
    let lines: Vec<String> = (names.iter())
        .map(|n| match described(&home.join(n)) {
            d if d.is_empty() => format!("- {n}"),
            d => format!("- {n}: {d}"),
        })
        .collect();
    let list = format!("The repos in {}:\n{}", home.display(), lines.join("\n"));
    if names.len() <= INLINE {
        return Some(format!("{}\n{list}", RULE.trim()));
    }
    let file = spec.dir.join("REPOS.md");
    crate::write_atomic(&file, format!("{list}\n").as_bytes()).ok()?;
    let n = names.len();
    Some(format!(
        "{}\nIts {n} repos are listed in {}: read it first.",
        RULE.trim(),
        file.display()
    ))
}

/// Where a session's claim of `name` keeps its record.
fn record(dir: &Path, name: &str) -> PathBuf {
    dir.join("repos").join(name)
}

/// The worker's parent session folder, from its link.
fn parent(spec: &Spec) -> Option<PathBuf> {
    let link: Value = serde_json::from_slice(&fs::read(spec.dir.join("worker.json")).ok()?).ok()?;
    Some(spec.dir.parent()?.join(link["parent"].as_str()?))
}

/// `brigadier repo <name>`: the session's own worktree of that repository, made on its first call
/// on a branch of its own, from the parent's branch there for a worker whose parent has one
/// [D3000], else from the repository's current branch. Its folder, and a line when the parent's
/// uncommitted edits there aren't in it.
pub fn claim(spec: &Spec, name: &str) -> io::Result<String> {
    let Some(project) = of(spec) else {
        return err("This chat's project isn't a folder of repos, so it has no repos to claim.");
    };
    let home = PathBuf::from(&project.folder);
    if !repos(&home).iter().any(|n| n == name) {
        return err(format!(
            "No repo {name:?} in {}. Name it as your map does, by its path in that folder.",
            home.display()
        ));
    }
    // Held through the claim, as delete holds it: a claim never outlives its session.
    let _session = worktrees::lock(&spec.dir)?;
    let own = worktrees::path(&data_of(spec), &spec.id);
    if !spec.dir.join("session.json").exists() || crate::session::lifecycle(&spec.dir).0.is_some() {
        return err("This chat is archived or being deleted.");
    }
    if Path::new(&spec.cwd) != own {
        return err("This chat works in the folder itself, so it has no copies of its own.");
    }
    let rec = record(&spec.dir, name);
    if worktrees::made(&rec) {
        return Ok(worktrees::folder(&rec)
            .unwrap_or_default()
            .display()
            .to_string());
    }
    fs::create_dir_all(&rec)?;
    let from = parent(spec)
        .map(|p| record(&p, name))
        .filter(|p| worktrees::made(p));
    let base = from
        .as_deref()
        .and_then(|p| worktrees::branch(p).ok().flatten());
    let title = fs::read_to_string(spec.dir.join("title")).unwrap_or_default();
    let title = match title.trim() {
        "" => name.rsplit('/').next().unwrap_or(name),
        t => t,
    };
    let path = own.join(name);
    // A link the agent made in its folder must never send a copy elsewhere.
    fs::create_dir_all(path.parent().unwrap_or(&own))?;
    let parent = fs::canonicalize(path.parent().unwrap_or(&own))?;
    if !parent.starts_with(fs::canonicalize(&own)?) || path.is_symlink() {
        return err(format!(
            "{} isn't inside this chat's folder.",
            path.display()
        ));
    }
    let repo = projects::Project {
        folder: home.join(name).display().to_string(),
        ..project
    };
    let claimer = Spec {
        dir: rec.clone(),
        ..spec.clone()
    };
    // Two calls at once: the one that lost the record's lock gets the other's folder.
    let made = worktrees::create(&claimer, &repo, base.as_deref(), None, title, Some(&path));
    made.or_else(|e| worktrees::made(&rec).then_some(()).ok_or(e))?;
    let mut out = worktrees::folder(&rec)
        .unwrap_or(path)
        .display()
        .to_string();
    let dirty = (from.as_deref().and_then(worktrees::folder)).is_some_and(|f| {
        Command::new("git")
            .arg("-C")
            .arg(f)
            .args(["status", "--porcelain"])
            .output()
            .is_ok_and(|o| !o.stdout.is_empty())
    });
    if dirty {
        out += "\nYour parent's uncommitted edits in this repo aren't in your copy.";
    }
    Ok(out)
}

/// The record folders of every repository the session claimed, by name.
pub fn claims(dir: &Path) -> Vec<(String, PathBuf)> {
    let root = dir.join("repos");
    let mut out = vec![];
    let mut walk = vec![root.clone()];
    while let Some(d) = walk.pop() {
        for e in fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if !e.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            match p.join("worktree.json").is_file() {
                true => out.push((p.strip_prefix(&root).unwrap_or(&p).display().to_string(), p)),
                false => walk.push(p),
            }
        }
    }
    out.sort();
    out
}

/// Takes every claim's worktree away for delete, as `worktrees::delete` does a session's; the
/// branches with work that never landed, kept, as `repo branch`.
pub fn delete(dir: &Path, drop: bool) -> io::Result<Vec<String>> {
    let mut kept = vec![];
    for (name, rec) in claims(dir) {
        let _one = worktrees::lock(&rec)?;
        kept.extend(worktrees::delete(&rec, drop)?.map(|b| format!("{name} {b}")));
    }
    Ok(kept)
}

/// Whether the session is a folder chat: fork, rewind and archive are off for it for now [D494].
pub fn chat(spec: &Spec) -> bool {
    of(spec).is_some()
}

/// Refuses `what` for a folder chat.
pub fn off(spec: &Spec, what: &str) -> io::Result<()> {
    match chat(spec) {
        true => err(format!(
            "{what} isn't available yet in a chat on a folder of repos."
        )),
        false => Ok(()),
    }
}
