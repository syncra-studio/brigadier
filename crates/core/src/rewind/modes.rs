//! The permissions a git tree can't keep, which is all but a file's executable bit: taken at each
//! capture and put back with the files, so none comes back more open than it was [D26].

use super::snap::{CHUNK, Shot, Store, done, fed, split};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, DirBuilder, Permissions};
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};

/// The permissions that aren't 644, or 755 for an executable or a folder, by path; a folder's ends
/// in `/`.
pub(crate) type Modes = BTreeMap<String, u32>;

/// What a tree's entry stands for on its own; None for a link or a nested repository.
pub(super) fn plain(entry: &str) -> Option<u32> {
    match entry {
        "100644" => Some(0o644),
        "100755" => Some(0o755),
        _ => None,
    }
}

/// The permissions of the file, or with `dir` the folder, that's at `path`.
fn of(path: &Path, dir: bool) -> Option<u32> {
    let m = fs::symlink_metadata(path).ok()?;
    let kind = if dir { m.is_dir() } else { m.is_file() };
    kind.then_some(m.mode() & 0o777)
}

fn set(path: &Path, mode: u32) -> io::Result<()> {
    let now = fs::symlink_metadata(path)?.mode();
    match now & 0o777 == mode {
        true => Ok(()),
        false => fs::set_permissions(path, Permissions::from_mode(now & 0o7000 | mode)),
    }
}

/// What a new file gets: git makes the index as it makes any.
pub(super) fn made(index: &Path) -> io::Result<u32> {
    Ok(fs::metadata(index)?.mode() & 0o666)
}

/// `mode` with its execute bits as its read ones where the file is an executable, none otherwise.
fn run(mode: u32, plain: u32) -> u32 {
    match plain {
        0o755 => mode & 0o666 | (mode & 0o444) >> 2,
        _ => mode & 0o666,
    }
}

/// Whether a file with permissions `now` is as `modes` has it, its entry's own being `plain`. `cut`,
/// what a new file gets: or as a write-back cut short leaves one it was still to set them on.
pub(super) fn same(
    modes: Option<&Modes>,
    path: &str,
    plain: u32,
    now: u32,
    cut: Option<u32>,
) -> bool {
    let Some(modes) = modes else {
        return (now & 0o100 != 0) == (plain == 0o755);
    };
    let want = *modes.get(path).unwrap_or(&plain);
    let unset = |made| want != run(made, plain) && now == run(0o600, plain);
    now == want || cut.is_some_and(unset)
}

/// The permissions that stand out in folder `root`, for an index's `entries` of it.
pub(crate) fn stand_out(root: &Path, entries: &[String]) -> Modes {
    let (mut all, mut dirs) = (Modes::new(), BTreeSet::new());
    for (meta, path) in entries.iter().filter_map(|e| e.split_once('\t')) {
        let mode = of(&root.join(path), false);
        if let Some((mode, plain)) = mode.zip(plain(meta.split(' ').next().unwrap_or("")))
            && mode != plain
        {
            all.insert(path.into(), mode);
        }
        let mut rest = path;
        while let Some((dir, _)) = rest.rsplit_once('/').filter(|(d, _)| dirs.insert(*d)) {
            if let Some(mode) = of(&root.join(dir), true).filter(|m| *m != 0o755) {
                all.insert(format!("{dir}/"), mode);
            }
            rest = dir;
        }
    }
    all
}

/// Every folder above `path`.
pub(super) fn above(path: &str) -> impl Iterator<Item = &str> {
    path.match_indices('/').map(|(i, _)| &path[..i])
}

/// Sets `all` on folder `root`, where its `entries` still have each; a file that has become an
/// executable since, or is none any more, stays that.
pub(crate) fn again(root: &Path, entries: &[String], all: &Modes) -> io::Result<()> {
    for (meta, path) in entries.iter().filter_map(|e| e.split_once('\t')) {
        let there = of(&root.join(path), false).and(plain(meta.split(' ').next().unwrap_or("")));
        if let Some((plain, mode)) = there.zip(all.get(path)) {
            let same = (mode & 0o100 != 0) == (plain == 0o755);
            let mode = if same { *mode } else { run(*mode, plain) };
            set(&root.join(path), mode)?;
        }
    }
    let paths = entries.iter().filter_map(|e| e.split_once('\t'));
    let dirs: BTreeSet<&str> = paths.flat_map(|(_, path)| above(path)).collect();
    // Inner folders first: an outer one may close the way.
    for dir in dirs.iter().rev() {
        if let Some(mode) = all.get(&format!("{dir}/")) {
            set(&root.join(dir), *mode)?;
        }
    }
    Ok(())
}

/// How a write-back leaves the permissions of what it writes.
pub(super) struct Back {
    files: BTreeMap<String, u32>,
    /// The folders its target names, as `<dir>/`: one it held nothing tracked in was there empty.
    dirs: Vec<String>,
    /// The folders the files go in, with their permissions where those are known.
    homes: BTreeMap<PathBuf, Option<u32>>,
    /// What this process's umask leaves a new file.
    made: u32,
}

impl Back {
    /// Whether a file goes back in `dir`.
    pub(super) fn home(&self, dir: &Path) -> bool {
        self.homes.contains_key(dir)
    }

    /// Whether a restore leaves folder `rel`: the target names it, or one above it that held
    /// nothing tracked, as git names a folder holding only empty ones [C37 D35]. `there`: the
    /// target's entries; `folds`: the disk takes two letter cases for one [D26].
    pub(super) fn kept(&self, rel: &str, there: &BTreeMap<&str, &str>, folds: bool) -> bool {
        let low = |s: &str| if folds { s.to_lowercase() } else { s.into() };
        let rel = low(&format!("{rel}/"));
        self.dirs.iter().any(|k| {
            let under = there.range(k.as_str()..).next();
            let empty = under.is_none_or(|(p, _)| !p.starts_with(k.as_str()));
            rel == low(k) || empty && rel.starts_with(&low(k))
        })
    }
}

impl Store {
    /// The folder's permissions now, for the index's `entries`, as a blob; empty where none stands out.
    /// The folders that hold nothing tracked go in too, as git keeps none, so a restore leaves
    /// them [C37]: on the store's index, all else being in it.
    pub(super) fn keep_modes(&self, entries: &[String]) -> io::Result<String> {
        let mut all = stand_out(self.cwd(), entries);
        let args = ["ls-files", "-z", "-o", "--directory", "--exclude-standard"];
        for dir in split(self.run(&self.git.join("index"), &args)?)? {
            let mode = dir.ends_with('/').then(|| of(&self.cwd().join(&dir), true));
            if let Some(mode) = mode.flatten() {
                all.entry(dir).or_insert(mode);
            }
        }
        self.save_modes(&all)
    }

    /// The folders that came between `end` and `next`, the user's: there at `next` and not at
    /// `end` [C37].
    pub(super) fn dirs_made(&self, end: &Shot, next: &Shot) -> io::Result<Modes> {
        if end.modes == next.modes {
            return Ok(Modes::new());
        }
        let (Some(a), Some(mut b)) = (self.modes(end)?, self.modes(next)?) else {
            return Ok(Modes::new());
        };
        let index = self.git.join("index");
        b.retain(|k, _| k.ends_with('/') && !a.contains_key(k));
        for dir in b.keys().cloned().collect::<Vec<_>>() {
            let tree = self.run(
                &index,
                &["ls-tree", &end.tree, "--", dir.trim_end_matches('/')],
            )?;
            if !tree.is_empty() {
                b.remove(&dir);
            }
        }
        Ok(b)
    }

    /// `modes`, a blob as `stricter` gives it, with the folders `made` names that it lacks, so a
    /// restore leaves them too [C37]. None, from before permissions were kept, stays None.
    pub(super) fn with_dirs(
        &self,
        modes: Option<String>,
        made: &Modes,
    ) -> io::Result<Option<String>> {
        let all = match made.is_empty() {
            true => None,
            false => self.modes(&Shot::at("", &modes))?,
        };
        let Some(mut all) = all else {
            return Ok(modes);
        };
        for (dir, mode) in made {
            all.entry(dir.clone()).or_insert(*mode);
        }
        Ok(Some(self.save_modes(&all)?))
    }

    pub(super) fn save_modes(&self, all: &Modes) -> io::Result<String> {
        if all.is_empty() {
            return Ok(String::new());
        }
        let hash = self.store(&self.git.join("index"), &["hash-object", "-w", "--stdin"]);
        let id = fed(hash, "hash-object", Some(&serde_json::to_string(all)?))?;
        Ok(String::from_utf8_lossy(&id).trim().into())
    }

    /// The permissions kept with `shot`; None for one taken before they were.
    pub(super) fn modes(&self, shot: &Shot) -> io::Result<Option<Modes>> {
        match shot.modes.as_deref() {
            None => Ok(None),
            Some("") => Ok(Some(Modes::new())),
            Some(id) => Ok(serde_json::from_slice(
                &self.read(&["cat-file", "blob", id])?,
            )?),
        }
    }

    /// The files whose permissions differ between two moments, both known.
    pub(super) fn modes_differ(&self, a: &Shot, b: &Shot) -> io::Result<BTreeSet<String>> {
        if a.modes == b.modes {
            return Ok(BTreeSet::new());
        }
        let (Some(a), Some(b)) = (self.modes(a)?, self.modes(b)?) else {
            return Ok(BTreeSet::new());
        };
        let mut paths: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
        paths.retain(|p| !p.ends_with('/') && a.get(*p) != b.get(*p));
        Ok(paths.into_iter().cloned().collect())
    }

    /// `to`'s permissions, with those of `paths` no more open than their files are now.
    pub(super) fn stricter<'a>(
        &self,
        to: &Shot,
        paths: impl Iterator<Item = &'a String>,
    ) -> io::Result<Option<String>> {
        let paths: BTreeSet<&str> = paths.map(String::as_str).collect();
        let Some(mut all) = self.modes(to)?.filter(|_| !paths.is_empty()) else {
            return Ok(to.modes.clone());
        };
        for entry in split(self.read(&["ls-tree", "-r", "-z", &to.tree])?)? {
            let Some((meta, path)) = entry.split_once('\t').filter(|e| paths.contains(e.1)) else {
                continue;
            };
            let plain = plain(meta.split(' ').next().unwrap_or(""));
            if let Some((plain, now)) = plain.zip(of(&self.cwd().join(path), false)) {
                let mode = all.get(path).unwrap_or(&plain) & run(now, plain);
                all.insert(path.into(), mode);
            }
        }
        Ok(Some(self.save_modes(&all)?))
    }

    /// Takes how `files`, each with its entry's own permissions, are put back as `to` has them.
    /// Where that isn't known, as on a capture from before permissions were kept, each keeps what
    /// its file has now where that's stricter.
    pub(super) fn back(
        &self,
        to: &Shot,
        index: &Path,
        files: &[(&String, Option<u32>)],
    ) -> io::Result<Back> {
        let modes = self.modes(to)?;
        let made = made(index)?;
        let dirs = (modes.iter().flatten()).filter(|(k, _)| k.ends_with('/'));
        let dirs = dirs.map(|(k, _)| k.clone()).collect();
        let (mut want, mut homes) = (BTreeMap::new(), BTreeMap::new());
        for (path, plain) in files {
            let mode = plain.and_then(|plain| match &modes {
                Some(m) => Some(m.get(*path).copied().unwrap_or(plain)),
                None => of(&self.cwd().join(path), false).map(|now| run(now & made, plain)),
            });
            want.extend(mode.map(|m| (path.to_string(), m)));
            let mut rest = path.as_str();
            while let Some((dir, _)) = rest.rsplit_once('/') {
                let mode = (modes.as_ref()).map(|m| *m.get(&format!("{dir}/")).unwrap_or(&0o755));
                if homes.insert(self.cwd().join(dir), mode).is_some() {
                    break;
                }
                rest = dir;
            }
        }
        Ok(Back {
            files: want,
            dirs,
            homes,
            made,
        })
    }

    /// Writes `files` from `index`, at no moment more open than `back` leaves them.
    pub(super) fn check_out(
        &self,
        index: &Path,
        files: &[(&String, Option<u32>)],
        back: &Back,
    ) -> io::Result<()> {
        // Parents come first; one that's there keeps its own permissions.
        let new: Vec<(&PathBuf, u32)> = (back.homes.iter())
            .filter_map(|(dir, mode)| Some((dir, (*mode)?)))
            .filter(|(dir, _)| fs::symlink_metadata(dir).is_err())
            .collect();
        for (dir, mode) in &new {
            DirBuilder::new().mode(mode | 0o700).create(dir)?;
        }
        let private = |(path, plain): &&(&String, Option<u32>)| {
            let made = plain.map(|p| run(back.made, p));
            back.files.get(*path).is_some_and(|m| Some(*m) != made)
        };
        let (own, usual): (Vec<_>, Vec<_>) = files.iter().partition(private);
        for (files, private) in [(usual, false), (own, true)] {
            for chunk in files.chunks(CHUNK) {
                let mut command = self.store(index, &["checkout-index", "-f", "--"]);
                command.args(chunk.iter().map(|(path, _)| path));
                if private {
                    // SAFETY: umask only sets the new process's own.
                    unsafe {
                        command.pre_exec(|| {
                            libc::umask(0o077);
                            Ok(())
                        })
                    };
                }
                done(command, "checkout-index")?;
            }
        }
        for (path, mode) in &back.files {
            set(&self.cwd().join(path), *mode)?;
        }
        (new.iter().rev()).try_for_each(|(dir, mode)| set(dir, *mode))
    }
}
