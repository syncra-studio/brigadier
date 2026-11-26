//! The working folder at each turn's edges, as git trees in a store of the session's own
//! (`sessions/<id>/rewind.git`) [D35]. Never the project's repository: its history, index and
//! hooks are untouched. Files the project ignores stay out, git's own data too (proposed).

use super::modes::{Modes, plain, same};
use super::names::rule;
use crate::adapters::setup;
use crate::worktrees::inner;
use crate::{Spec, write_atomic};
use brigadier_frames::log::now_ms;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;

pub(super) const STORE: &str = "rewind.git";
/// An untracked file past this size isn't kept, and is named wherever it matters (proposed).
const MAX_FILE: u64 = 2 << 20;
const GIT_SECS: u64 = 60;
/// Paths per git call, well under the system's limit on arguments.
pub(super) const CHUNK: usize = 200;

/// The folder at one moment. `out` holds what the tree can't: each big untracked file's size and
/// time, each nested repository's commit, none yet as "", by path. `at`: when its capture started (ms), so a
/// turn spans its two captures [D1078, D1089]; none on one taken before that.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Shot {
    pub tree: String,
    pub head: Option<String>,
    pub out: BTreeMap<String, String>,
    /// The permissions the tree can't keep, a blob in the store [D26]; empty where none stands out.
    /// None on one taken before they were kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<u64>,
}

impl Shot {
    /// A capture's `tree` and permissions alone, as an operation's record keeps its target.
    pub(super) fn at(tree: &str, modes: &Option<String>) -> Shot {
        Shot {
            tree: tree.into(),
            modes: modes.clone(),
            ..Shot::default()
        }
    }
}

/// One turn's two edges. A missing end means no restore across it.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Record {
    pub before: Shot,
    pub end: Option<Shot>,
}

pub struct Store {
    dir: PathBuf,
    pub(super) git: PathBuf,
    cwd: PathBuf,
}

pub(super) fn done(command: Command, what: &str) -> io::Result<Vec<u8>> {
    fed(command, what, None)
}

/// `done` with `input` on its stdin.
pub(super) fn fed(mut command: Command, what: &str, input: Option<&str>) -> io::Result<Vec<u8>> {
    let never = AtomicBool::new(false);
    let out = setup::run_fed(&mut command, GIT_SECS, &never, input).map_err(io::Error::other)?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    let why = String::from_utf8_lossy(&out.stderr);
    Err(io::Error::other(format!("git {what}: {}", why.trim())))
}

// shortcut: a path that isn't UTF-8 fails the snapshot, so that range offers keep only; carry bytes if anyone hits it.
pub(super) fn split(bytes: Vec<u8>) -> io::Result<Vec<String>> {
    let text = String::from_utf8(bytes).map_err(io::Error::other)?;
    Ok(text
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect())
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

    /// A folder chat's claimed repo: its own store in the claim's record folder, over its copy [D3105].
    pub fn claim(rec: &Path) -> Option<Store> {
        let cwd = fs::canonicalize(crate::worktrees::folder(rec)?).ok()?;
        let dir = fs::canonicalize(rec).ok()?;
        let git = dir.join(STORE);
        Some(Store { dir, git, cwd })
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

    pub(super) fn lock(&self) -> io::Result<File> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.dir.join("rewind.lock"))?;
        file.lock()?;
        Ok(file)
    }

    /// Git on the project's own repository, read only.
    pub(super) fn source(&self, args: &[&str]) -> io::Result<Vec<u8>> {
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
    pub(super) fn store(&self, index: &Path, args: &[&str]) -> Command {
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

    /// Git on the store, to compare two captures it holds: Review's Last turn [D1000, D1192]. It
    /// writes nothing; Last turn's capture of the folder now goes through `capture`.
    pub fn read(&self, args: &[&str]) -> io::Result<Vec<u8>> {
        self.run(&self.git.join("index"), args)
    }

    /// The folder the captures are of.
    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    pub(super) fn run(&self, index: &Path, args: &[&str]) -> io::Result<Vec<u8>> {
        done(self.store(index, args), args[0])
    }

    pub(super) fn each(&self, index: &Path, args: &[&str], paths: &[&String]) -> io::Result<()> {
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
            // Only a repository comes as a folder: git refuses one with no commit.
            if let Some(repo) = path.strip_suffix('/') {
                if !inner::has_commit(&self.cwd.join(repo)) {
                    out.insert(repo.into(), String::new());
                }
                continue;
            }
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
        self.respell(&index)?;
        let entries = split(self.run(&index, &["ls-files", "-s", "-z"])?)?;
        for line in &entries {
            if let (Some(rest), Some((meta, path))) =
                (line.strip_prefix("160000 "), line.split_once('\t'))
            {
                let commit = rest.split(' ').next().unwrap_or(meta);
                out.insert(path.into(), commit.into());
            }
        }
        let modes = Some(self.keep_modes(&entries)?);
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
            modes,
            at,
        })
    }

    /// The paths that differ between two moments, as git has them.
    pub fn diff(&self, a: &Shot, b: &Shot) -> io::Result<BTreeSet<String>> {
        let index = self.git.join("index");
        let args = ["diff-tree", "-r", "-z", "--name-only", "--no-renames"];
        let args = [&args[..], &[&a.tree, &b.tree]].concat();
        Ok(split(self.run(&index, &args)?)?.into_iter().collect())
    }

    /// Whether writing `path` would go through a link, or take something `changed` doesn't name.
    pub fn blocked(&self, path: &str, changed: &BTreeSet<String>) -> bool {
        // What's there under another letter case is some other path's.
        let named = |path: &str| self.spelled(path).unwrap_or(path.into());
        let parts: Vec<&str> = path.split('/').collect();
        let mut at = self.cwd.clone();
        for (i, part) in parts[..parts.len() - 1].iter().enumerate() {
            at.push(part);
            let Ok(m) = fs::symlink_metadata(&at) else {
                return false;
            };
            // One that's named is gone by the time `path` is written.
            if !m.is_dir() {
                return !changed.contains(&named(&parts[..=i].join("/")));
            }
        }
        at.push(parts[parts.len() - 1]);
        let there = named(path);
        match fs::symlink_metadata(&at) {
            Ok(m) if m.is_dir() => self.foreign(&at, &there, changed),
            _ => there != path && !changed.contains(&there),
        }
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

    /// Whether the folder is a git repository: snapshots are taken only of one.
    pub fn is_repo(&self) -> bool {
        self.source(&["rev-parse", "--git-dir"]).is_ok()
    }

    /// Whether `path` is now exactly as `tree` has it, by type, mode and bytes; absent where it
    /// has none. Anything that can't be read, or a nested repository, isn't. `modes`: the tree's;
    /// `cut`: as `same` takes it.
    pub(super) fn holds(
        &self,
        tree: &str,
        modes: Option<&Modes>,
        path: &str,
        cut: Option<u32>,
    ) -> bool {
        let index = self.git.join("index");
        let Ok(entry) = self.run(&index, &["ls-tree", "-z", tree, "--", path]) else {
            return false;
        };
        let entry = String::from_utf8_lossy(&entry);
        // Under another letter case it's some other path's file.
        let disk = match self.spelled(path).is_some_and(|there| there != path) {
            true => Err(io::ErrorKind::NotFound.into()),
            false => fs::symlink_metadata(self.cwd.join(path)),
        };
        // A file the turn put in a folder's place, or the other way round, leaves its path absent.
        let gone = |e: io::Error| {
            matches!(
                e.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            )
        };
        let Some((meta, _)) = entry.split_once('\t') else {
            return disk.is_err_and(gone);
        };
        let meta: Vec<&str> = meta.split(' ').collect();
        if meta.get(1) == Some(&"tree") {
            return disk.map_or_else(gone, |m| m.is_dir());
        }
        let (Ok(disk), &[mode, "blob", blob]) = (disk, &meta[..]) else {
            return false;
        };
        let bytes = match mode {
            "120000" if disk.is_symlink() => {
                fs::read_link(self.cwd.join(path)).map(|l| l.into_os_string().into_encoded_bytes())
            }
            "100644" | "100755" if disk.is_file() => {
                let now = disk.mode() & 0o777;
                if !plain(mode).is_some_and(|plain| same(modes, path, plain, now, cut)) {
                    return false;
                }
                fs::read(self.cwd.join(path))
            }
            _ => return false,
        };
        let stored = self.run(&index, &["cat-file", "blob", blob]);
        matches!((bytes, stored), (Ok(a), Ok(b)) if a == b)
    }

    /// Puts `paths` back as `to` has them, their permissions too; those it doesn't have are removed,
    /// emptied folders with them. Nothing else in the folder is touched.
    pub fn write_back(&self, to: &Shot, paths: &BTreeSet<String>) -> io::Result<()> {
        let _one = self.lock()?;
        let index = self.git.join("restore.index");
        // Only a write-back cut short leaves these, and the lock says none is running.
        let _ = fs::remove_file(self.git.join("restore.index.lock"));
        let _ = fs::remove_file(&index);
        self.run(&index, &["read-tree", &to.tree])?;
        let entries = split(self.run(&index, &["ls-files", "-s", "-z"])?)?;
        let there: BTreeMap<&str, &str> = (entries.iter())
            .filter_map(|e| e.split_once('\t').map(|(meta, path)| (path, meta)))
            .collect();
        let files: Vec<(&String, Option<u32>)> = (paths.iter())
            .filter_map(|p| Some((p, plain(there.get(p.as_str())?.split(' ').next()?))))
            .collect();
        let back = self.back(to, &index, &files)?;
        let rel = |d: &Path| {
            d.strip_prefix(&self.cwd)
                .unwrap_or(d)
                .to_string_lossy()
                .into_owned()
        };
        let folds = self.folds();
        for path in paths.iter().filter(|p| !there.contains_key(p.as_str())) {
            let file = self.cwd.join(path);
            match fs::remove_file(&file) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
            let mut up = file.parent();
            // A folder a file goes back in stays, with its permissions, and so does one that was
            // there at `to`, empty [C37].
            let mine = |d: &Path| !back.home(d) && !back.kept(&rel(d), &there, folds);
            while let Some(dir) =
                up.filter(|d| *d != self.cwd && mine(d) && fs::remove_dir(d).is_ok())
            {
                up = dir.parent();
            }
        }
        self.check_out(&index, &files, &back)?;
        if files.len() < paths.len() {
            (files.iter()).try_for_each(|(path, _)| self.spell(path, paths))?;
        }
        fs::remove_file(index)
    }
}
