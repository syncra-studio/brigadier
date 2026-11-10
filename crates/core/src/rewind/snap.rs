//! The working folder at each turn's edges, as git trees in a store of the session's own
//! (`sessions/<id>/rewind.git`) [D35]. Never the project's repository: its history, index and
//! hooks are untouched. Files the project ignores stay out, git's own data too (proposed).

use crate::adapters::setup;
use crate::{Spec, check_id, write_atomic};
use brigadier_frames::log::now_ms;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;

pub(super) const STORE: &str = "rewind.git";
/// An untracked file past this size isn't kept, and is named wherever it matters (proposed).
const MAX_FILE: u64 = 2 << 20;
const GIT_SECS: u64 = 60;
/// Paths per git call, well under the system's limit on arguments.
const CHUNK: usize = 200;

/// The folder at one moment. `out` holds what the tree can't: each big untracked file's size and
/// time, each nested repository's commit, by path. `at`: when its capture started (ms), so a
/// turn spans its two captures [D1078, D1089]; none on one taken before that.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Shot {
    pub tree: String,
    pub head: Option<String>,
    pub out: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<u64>,
}

/// One turn's two edges. A missing end means no restore across it.
#[derive(Serialize, Deserialize, Default)]
pub struct Record {
    pub before: Shot,
    pub end: Option<Shot>,
}

pub struct Store {
    dir: PathBuf,
    git: PathBuf,
    cwd: PathBuf,
}

fn done(mut command: Command, what: &str) -> io::Result<Vec<u8>> {
    let out = setup::run(&mut command, GIT_SECS).map_err(io::Error::other)?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    let why = String::from_utf8_lossy(&out.stderr);
    Err(io::Error::other(format!("git {what}: {}", why.trim())))
}

// shortcut: a path that isn't UTF-8 fails the snapshot, so that range offers keep only; carry bytes if anyone hits it.
fn split(bytes: Vec<u8>) -> io::Result<Vec<String>> {
    let text = String::from_utf8(bytes).map_err(io::Error::other)?;
    Ok(text
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect())
}

/// A path as an anchored ignore rule that matches only it.
fn rule(path: &str) -> String {
    let mut out = String::from("/");
    for c in path.chars() {
        if matches!(c, '\\' | '*' | '?' | '[' | ']' | ' ' | '!' | '#') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

impl Store {
    /// None for a session with no project, or a folder that holds the session's own data.
    pub fn of(spec: &Spec) -> Option<Store> {
        spec.project.as_ref()?;
        let cwd = fs::canonicalize(&spec.cwd).ok()?;
        let dir = fs::canonicalize(&spec.dir).ok()?;
        let git = dir.join(STORE);
        (!dir.starts_with(&cwd)).then_some(Store { dir, git, cwd })
    }

    /// The same store over another folder, a fork's new worktree, to write a snapshot there [D1068].
    pub fn over(&self, cwd: &Path) -> io::Result<Store> {
        let (dir, git) = (self.dir.clone(), self.git.clone());
        Ok(Store {
            dir,
            git,
            cwd: fs::canonicalize(cwd)?,
        })
    }

    /// Whether the project's repository still holds `commit`.
    pub fn has(&self, commit: &str) -> bool {
        let rev = format!("{commit}^{{commit}}");
        self.source(&["cat-file", "-e", &rev]).is_ok()
    }

    fn lock(&self) -> io::Result<File> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.dir.join("rewind.lock"))?;
        file.lock()?;
        Ok(file)
    }

    /// Git on the project's own repository, read only.
    fn source(&self, args: &[&str]) -> io::Result<Vec<u8>> {
        let mut command = Command::new("git");
        command
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.fsmonitor=false",
            ])
            .arg("-C")
            .arg(&self.cwd)
            .args(args);
        done(command, args[0])
    }

    /// Git on the store, over the working folder. Literal paths, and bytes as they are on disk.
    fn store(&self, index: &Path, args: &[&str]) -> Command {
        let mut command = Command::new("git");
        command
            .args([
                "-c",
                "core.autocrlf=false",
                "-c",
                "core.hooksPath=/dev/null",
            ])
            .args(["-c", "core.fsmonitor=false"])
            .args(args)
            .env("GIT_DIR", &self.git)
            .env("GIT_WORK_TREE", &self.cwd)
            .env("GIT_INDEX_FILE", index)
            .env("GIT_LITERAL_PATHSPECS", "1")
            .current_dir(&self.cwd);
        command
    }

    fn run(&self, index: &Path, args: &[&str]) -> io::Result<Vec<u8>> {
        done(self.store(index, args), args[0])
    }

    fn each(&self, index: &Path, args: &[&str], paths: &[&String]) -> io::Result<()> {
        for chunk in paths.chunks(CHUNK) {
            let mut command = self.store(index, args);
            command.arg("--").args(chunk);
            done(command, args[0])?;
        }
        Ok(())
    }

    fn init(&self) -> io::Result<()> {
        // Written last, so it's there only once the store is whole.
        if self.git.join("info/attributes").exists() {
            return Ok(());
        }
        let mut command = Command::new("git");
        command
            .args(["init", "-q", "--bare", "--template="])
            .arg(&self.git);
        done(command, "init")?;
        self.run(&self.git.join("index"), &["config", "gc.auto", "0"])?;
        fs::create_dir_all(self.git.join("info"))?;
        // The same bytes back, whatever the project's filters and line endings do.
        fs::write(
            self.git.join("info/attributes"),
            "* -text -filter -ident -working-tree-encoding\n",
        )
    }

    /// The folder now. Fails where the folder isn't a git repository: that range offers keep only.
    pub fn capture(&self) -> io::Result<Shot> {
        let at = Some(now_ms());
        let _one = self.lock()?;
        self.init()?;
        let index = self.git.join("index");
        // Only a capture cut short leaves this, and the lock says none is running.
        let _ = fs::remove_file(self.git.join("index.lock"));
        let mut out = BTreeMap::new();
        for path in split(self.source(&["ls-files", "-o", "--exclude-standard", "-z"])?)? {
            let Ok(m) = fs::symlink_metadata(self.cwd.join(&path)) else {
                continue;
            };
            if m.is_file() && m.len() > MAX_FILE && !path.contains('\n') {
                let stamp = format!("{}:{}.{}", m.len(), m.mtime(), m.mtime_nsec());
                out.insert(path, stamp);
            }
        }
        // The project's own personal ignores count, then this snapshot's big files.
        let own = split(self.source(&["rev-parse", "--git-path", "info/exclude"])?)?;
        let own = own.first().map_or("", |p| p.trim_end());
        let mut exclude = fs::read_to_string(self.cwd.join(own)).unwrap_or_default();
        for path in out.keys() {
            exclude += &format!("\n{}", rule(path));
        }
        write_atomic(&self.git.join("info/exclude"), exclude.as_bytes())?;
        let big: Vec<&String> = out.keys().collect();
        self.each(&index, &["update-index", "--force-remove"], &big)?;
        self.run(&index, &["add", "-A"])?;
        // A tracked file that also matches an ignore rule is still the project's.
        let tracked = split(self.source(&["ls-files", "-c", "-i", "--exclude-standard", "-z"])?)?;
        let tracked: Vec<&String> = tracked.iter().collect();
        self.each(&index, &["add", "-f"], &tracked)?;
        for line in split(self.run(&index, &["ls-files", "-s", "-z"])?)? {
            if let (Some(rest), Some((meta, path))) =
                (line.strip_prefix("160000 "), line.split_once('\t'))
            {
                let commit = rest.split(' ').next().unwrap_or(meta);
                out.insert(path.into(), commit.into());
            }
        }
        let tree = String::from_utf8_lossy(&self.run(&index, &["write-tree"])?)
            .trim()
            .to_string();
        let head = self
            .source(&["rev-parse", "-q", "--verify", "HEAD"])
            .ok()
            .map(|h| String::from_utf8_lossy(&h).trim().to_string());
        Ok(Shot {
            tree,
            head,
            out,
            at,
        })
    }

    fn record(&self, cid: &str) -> io::Result<PathBuf> {
        check_id(cid)?;
        Ok(self.git.join("turns").join(format!("{cid}.json")))
    }

    pub fn load(&self, cid: &str) -> Option<Record> {
        serde_json::from_slice(&fs::read(self.record(cid).ok()?).ok()?).ok()
    }

    pub fn save(&self, cid: &str, record: &Record) -> io::Result<()> {
        let path = self.record(cid)?;
        fs::create_dir_all(self.git.join("turns"))?;
        write_atomic(&path, &serde_json::to_vec(record)?)
    }

    /// Every turn's record, oldest first by its first capture; those with no time first.
    pub fn records(&self) -> Vec<Record> {
        let turns = fs::read_dir(self.git.join("turns"))
            .into_iter()
            .flatten()
            .flatten();
        let mut all: Vec<Record> = turns
            .filter_map(|e| serde_json::from_slice(&fs::read(e.path()).ok()?).ok())
            .collect();
        all.sort_by_key(|r| r.before.at);
        all
    }

    /// The paths that differ between two moments.
    pub fn diff(&self, a: &Shot, b: &Shot) -> io::Result<BTreeSet<String>> {
        let index = self.git.join("index");
        let args = ["diff-tree", "-r", "-z", "--name-only", "--no-renames"];
        let args = [&args[..], &[&a.tree, &b.tree]].concat();
        Ok(split(self.run(&index, &args)?)?.into_iter().collect())
    }

    /// Whether writing `path` would go through a link, or take something `changed` doesn't name.
    pub fn blocked(&self, path: &str, changed: &BTreeSet<String>) -> bool {
        let parts: Vec<&str> = path.split('/').collect();
        let mut at = self.cwd.clone();
        for (i, part) in parts[..parts.len() - 1].iter().enumerate() {
            at.push(part);
            let Ok(m) = fs::symlink_metadata(&at) else {
                return false;
            };
            if m.is_symlink() || (!m.is_dir() && !changed.contains(&parts[..=i].join("/"))) {
                return true;
            }
        }
        at.push(parts[parts.len() - 1]);
        fs::symlink_metadata(&at).is_ok_and(|m| m.is_dir()) && self.foreign(&at, path, changed)
    }

    /// Whether a folder holds anything `changed` doesn't name.
    fn foreign(&self, dir: &Path, rel: &str, changed: &BTreeSet<String>) -> bool {
        fs::read_dir(dir).into_iter().flatten().flatten().any(|e| {
            let rel = format!("{rel}/{}", e.file_name().to_string_lossy());
            match e.file_type() {
                Ok(t) if t.is_dir() => self.foreign(&e.path(), &rel, changed),
                _ => !changed.contains(&rel),
            }
        })
    }

    /// Puts `paths` back as `tree` has them; those it doesn't have are removed, emptied folders
    /// with them. Nothing else in the folder is touched.
    pub fn write_back(&self, tree: &str, paths: &BTreeSet<String>) -> io::Result<()> {
        let _one = self.lock()?;
        let index = self.git.join("restore.index");
        // Only a write-back cut short leaves these, and the lock says none is running.
        let _ = fs::remove_file(self.git.join("restore.index.lock"));
        let _ = fs::remove_file(&index);
        self.run(&index, &["read-tree", tree])?;
        let there: BTreeSet<String> = split(self.run(&index, &["ls-files", "-z"])?)?
            .into_iter()
            .collect();
        for path in paths.iter().filter(|p| !there.contains(*p)) {
            let file = self.cwd.join(path);
            match fs::remove_file(&file) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
            let mut up = file.parent();
            while let Some(dir) = up.filter(|d| *d != self.cwd && fs::remove_dir(d).is_ok()) {
                up = dir.parent();
            }
        }
        let back: Vec<&String> = paths.iter().filter(|p| there.contains(*p)).collect();
        self.each(&index, &["checkout-index", "-f"], &back)?;
        fs::remove_file(index)
    }
}
