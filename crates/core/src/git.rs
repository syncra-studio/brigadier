//! A checkout's git state for the right panel [D30, D71]: which checkout a session or project
//! works in, its status, a lock per checkout, and paths kept inside it. Git itself does the work,
//! as the old app's `crates/git` did.

use crate::adapters::setup;
use crate::{check_id, load, projects, session_dir, worktrees};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{self, File, TryLockError};
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

pub mod branch;
pub mod change;
pub mod commit;
pub mod diff;
pub mod files;
pub mod history;
pub mod land;
pub mod last;
mod listed;
mod precheck;
pub mod push;
pub mod recover;
pub mod replace;
pub mod risk;
pub mod search;
pub mod step;
pub mod sync;
pub mod truth;
pub mod watch;

/// Proposed: a read gives up after this, so a hung git never holds its watch.
const READ_SECS: u64 = 30;
/// How often a wait for the lock looks again, and at `stop`.
const STEP: Duration = Duration::from_millis(20);

fn err<T>(message: impl Into<String>) -> io::Result<T> {
    Err(io::Error::other(message.into()))
}

pub enum Target<'a> {
    Session(&'a str),
    Project(&'a str),
}

/// One checkout: its top folder and its own git folder, both canonical.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Checkout {
    pub root: PathBuf,
    pub git_dir: PathBuf,
    /// A session's own worktree under `sessions/<id>/`, not a folder of the user's [D1021].
    pub worktree: bool,
}

/// The checkout a session or project works in, chosen here and never taken from a client: a
/// session's own worktree, else its folder (Local checkout), or a project's folder [D160, D1039].
/// An archived session's worktree is gone until restore, so it's not found [D180].
pub fn checkout(data: &Path, target: &Target) -> io::Result<Checkout> {
    let folder = folder(data, target)?;
    if !folder.is_dir() {
        return Err(io::ErrorKind::NotFound.into());
    }
    let never = AtomicBool::new(false);
    let out = read(
        &folder,
        &["rev-parse", "--show-toplevel", "--absolute-git-dir"],
        &never,
    )?;
    let text = String::from_utf8(out).map_err(io::Error::other)?;
    match text.lines().collect::<Vec<_>>()[..] {
        [root, git_dir] => {
            let root = fs::canonicalize(root)?;
            let sessions = fs::canonicalize(data.join("sessions")).ok();
            Ok(Checkout {
                worktree: root.ends_with("worktree")
                    && root.parent().and_then(Path::parent) == sessions.as_deref(),
                root,
                git_dir: fs::canonicalize(git_dir)?,
            })
        }
        _ => err(format!("{} isn't a git checkout", folder.display())),
    }
}

/// The folder `checkout` looks in, found without running git.
pub fn folder(data: &Path, target: &Target) -> io::Result<PathBuf> {
    Ok(match target {
        Target::Session(id) => {
            check_id(id)?;
            if worktrees::made(&session_dir(data, id)) {
                // Its own, or one handed on with its record [D1080].
                worktrees::folder(&session_dir(data, id)).unwrap_or(worktrees::path(data, id))
            } else {
                PathBuf::from(load(data, id)?.cwd)
            }
        }
        Target::Project(id) => PathBuf::from(projects::get(data, id)?.folder),
    })
}

/// A read-only git in `dir`, ended early by `stop`: it takes no optional lock (so never the index
/// lock from under the agent's own git), and paths are read literally, never as patterns.
pub(crate) fn read(dir: &Path, args: &[&str], stop: &AtomicBool) -> io::Result<Vec<u8>> {
    let mut command = worktrees::command(dir);
    command
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(args);
    let out = setup::run_until(&mut command, READ_SECS, stop).map_err(io::Error::other)?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return err(format!("git {}: {why}", args.join(" ")));
    }
    Ok(out.stdout)
}

/// The checkout's lock [D1060]: an flock on its own git folder, so it makes no file of its own.
/// Reads take it shared and writes exclusive. It waits in steps, so `stop` ends the wait.
pub fn lock(checkout: &Checkout, exclusive: bool, stop: &AtomicBool) -> io::Result<File> {
    let file = File::open(&checkout.git_dir)?;
    loop {
        let got = match exclusive {
            true => file.try_lock(),
            false => file.try_lock_shared(),
        };
        match got {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) if !stop.load(Ordering::SeqCst) => thread::sleep(STEP),
            Err(TryLockError::WouldBlock) => return err("stopped"),
            Err(TryLockError::Error(e)) => return Err(e),
        }
    }
}

/// `rel` as a path in the checkout, refused unless it's a plain relative path (no `.`, `..` or
/// `.git` part) that, links followed as far as it exists, stays inside and out of `.git`.
pub fn inside(checkout: &Checkout, rel: &str) -> io::Result<PathBuf> {
    let refused = || err(format!("not a path in the checkout: {rel:?}"));
    if rel.contains(['\0', '\\'])
        || rel
            .split('/')
            .any(|part| matches!(part, "" | "." | ".." | ".git"))
    {
        return refused();
    }
    let full = checkout.root.join(rel);
    // The nearest part that's there, a link included: a dangling link fails to resolve, so it's
    // refused rather than skipped.
    let existing = (full.ancestors())
        .find(|p| fs::symlink_metadata(p).is_ok())
        .unwrap_or(&full);
    let resolved = fs::canonicalize(existing).or_else(|_| refused())?;
    match resolved.strip_prefix(&checkout.root) {
        Ok(under) if !under.components().any(|c| c.as_os_str() == ".git") => Ok(full),
        _ => refused(),
    }
}

/// A checkout's status as the panel shows it: `head` is the branch line and the count, `files`
/// one entry per changed path, which is its id [D30, D65]. Rust sends structure; the UI writes the
/// words and letters.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct Status {
    pub head: Value,
    pub files: BTreeMap<String, Value>,
}

impl Status {
    pub fn json(&self) -> Value {
        json!({"head": self.head, "files": self.files.values().collect::<Vec<_>>()})
    }

    /// What changed from `old`, as one push: the head whole, the files new or changed by path,
    /// and the paths no longer changed. None when nothing did.
    pub fn delta(&self, old: &Status) -> Option<Value> {
        let files: Vec<&Value> = (self.files.iter())
            .filter(|(path, entry)| old.files.get(*path) != Some(entry))
            .map(|(_, entry)| entry)
            .collect();
        let gone: Vec<&String> = (old.files.keys())
            .filter(|path| !self.files.contains_key(*path))
            .collect();
        (self.head != old.head || !files.is_empty() || !gone.is_empty())
            .then(|| json!({"head": self.head, "files": files, "gone": gone}))
    }
}

/// The checkout's status from one `git status`, taken under its shared lock so it never reads half
/// of one of our own writes.
// shortcut: a huge untracked list (an unignored node_modules) is read and sent whole; cap it when
// that shows up.
pub fn status(checkout: &Checkout, stop: &AtomicBool) -> io::Result<Status> {
    let _shared = lock(checkout, false, stop)?;
    let out = read(
        &checkout.root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
        stop,
    )?;
    let mut status = parse(&checkout.root, &out)?;
    // Which quick pick the branch item opens, and where Publish would push before any upstream
    // [D1020, D1021].
    let head = &mut status.head;
    head["checkout"] = if checkout.worktree {
        "worktree"
    } else {
        "folder"
    }
    .into();
    head["remote"] = match (head["branch"].as_str(), head["upstream"].as_str()) {
        (Some(branch), None) => push::remote(checkout, branch).ok().into(),
        // shortcut: a remote whose name has a `/` shows cut; only a name, never acted on.
        (_, Some(upstream)) => upstream.split('/').next().into(),
        _ => Value::Null,
    };
    Ok(status)
}

/// `git status --porcelain=v2 -z --branch`, taken from the old app's `source_changes`: the index
/// code (X) is the staged side, the files code (Y) the other; an unmerged entry is conflicted.
fn parse(root: &Path, bytes: &[u8]) -> io::Result<Status> {
    let text = std::str::from_utf8(bytes).map_err(|_| io::Error::other("non-UTF-8 git output"))?;
    let bad = |record: &str| io::Error::other(format!("unexpected git status line {record:?}"));
    let (mut head, mut files) = (
        json!({"branch": null, "head": null, "upstream": null,
        "ahead": 0, "behind": 0}),
        BTreeMap::new(),
    );
    let mut records = text.split('\0').filter(|r| !r.is_empty());
    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" if value != "(initial)" => head["head"] = value.into(),
                "branch.head" if value != "(detached)" => head["branch"] = value.into(),
                "branch.upstream" => head["upstream"] = value.into(),
                "branch.ab" => {
                    let mut counts = value
                        .split(' ')
                        .map(|c| c.get(1..).and_then(|n| n.parse::<u64>().ok()));
                    head["ahead"] = counts.next().flatten().ok_or_else(|| bad(record))?.into();
                    head["behind"] = counts.next().flatten().ok_or_else(|| bad(record))?.into();
                }
                _ => {}
            }
            continue;
        }
        let (path, old, staged, changes, index) = match record.as_bytes()[0] {
            b'!' => continue,
            b'?' => (&record[2..], None, None, Some("untracked"), String::new()),
            kind @ (b'1' | b'2' | b'u') => {
                let count = match kind {
                    b'1' => 9,
                    b'2' => 10,
                    _ => 11,
                };
                let parts: Vec<&str> = record.splitn(count, ' ').collect();
                if parts.len() != count || parts[1].len() != 2 {
                    return Err(bad(record));
                }
                let old = match kind {
                    b'2' => Some(records.next().ok_or_else(|| bad(record))?),
                    _ => None,
                };
                let side = |code: u8| match code {
                    b'.' => Ok(None),
                    b'M' => Ok(Some("modified")),
                    b'A' => Ok(Some("added")),
                    b'D' => Ok(Some("deleted")),
                    b'R' => Ok(Some("renamed")),
                    b'C' => Ok(Some("copied")),
                    b'T' => Ok(Some("typeChanged")),
                    _ => Err(bad(record)),
                };
                let codes = parts[1].as_bytes();
                match kind {
                    b'u' => (
                        parts[count - 1],
                        None,
                        None,
                        Some("conflicted"),
                        String::new(),
                    ),
                    // The staged version's mode and blob: staging more of a file changes them.
                    _ => {
                        let index = format!("{} {}", parts[4], parts[7]);
                        (
                            parts[count - 1],
                            old,
                            side(codes[0])?,
                            side(codes[1])?,
                            index,
                        )
                    }
                }
            }
            _ => return Err(bad(record)),
        };
        files.insert(
            path.to_string(),
            json!({"path": path, "old": old, "staged": staged,
            "changes": changes, "stamp": stamp(&root.join(path), &index)}),
        );
    }
    head["count"] = files.len().into();
    // The toggle's dot [D1025]: changes, for now. Ready, would-conflict and failed checks come with
    // the facts that tell them (the land pre-check, the PR watch); until then none is guessed [D74].
    head["hint"] = match files.len() {
        0 => Value::Null,
        n => json!({"tone": "changes", "count": n}),
    };
    Ok(Status { head, files })
}

/// When the file was last written and its size (`-` once gone), then its staged version: an edit
/// to a file already changed, or staging more of it, shows here though its status doesn't, so a
/// viewer or diff knows to read it again [D30]. Opaque to the UI: it's only compared.
fn stamp(path: &Path, index: &str) -> String {
    let file = fs::symlink_metadata(path).map_or("-".into(), |m| {
        format!("{}.{:09}:{}", m.mtime(), m.mtime_nsec(), m.size())
    });
    format!("{file} {index}").trim_end().to_string()
}

/// Proposed: the viewer reads this much of a file, as the old app did.
const FILE_MAX: u64 = 1024 * 1024;

/// A checkout file as the viewer shows it [D1002]: `{size, text, truncated}`, text null for a
/// binary file; `{gone: true}` once it's not there.
pub fn read_file(checkout: &Checkout, rel: &str) -> io::Result<Value> {
    use std::io::Read;
    let path = inside(checkout, rel)?;
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(json!({"gone": true})),
        Err(e) => return Err(e),
    };
    let meta = file.metadata()?;
    if !meta.is_file() {
        return err(format!("{rel} is not a file"));
    }
    let mut bytes = vec![];
    file.take(FILE_MAX).read_to_end(&mut bytes)?;
    let binary = bytes[..bytes.len().min(8000)].contains(&0);
    // A cut can split a character, and a file may not be UTF-8 at all.
    let text = (!binary).then(|| String::from_utf8_lossy(&bytes).into_owned());
    Ok(json!({"size": meta.len(), "text": text, "truncated": meta.len() > FILE_MAX}))
}
