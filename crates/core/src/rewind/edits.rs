//! The user's own edit of a file that the agent then renamed or removed: it goes back as the user
//! left it, so a rewind never removes it with the agent's copy [D26].

use super::modes::{Modes, above};
use super::snap::{Shot, Store, fed, split};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;

impl Store {
    /// Whether no file is at `path` now; one that's only reached through a link isn't.
    pub(super) fn absent(&self, path: &str) -> bool {
        let at = |p: &str| fs::symlink_metadata(self.cwd().join(p));
        at(path).map_or(true, |m| m.is_dir())
            || above(path).any(|d| at(d).is_ok_and(|m| m.is_symlink()))
    }

    /// The files in `now` that git takes for copies of `paths` as `of` has them.
    pub(super) fn copies(
        &self,
        of: &Shot,
        now: &Shot,
        paths: &BTreeSet<String>,
    ) -> io::Result<Vec<String>> {
        if paths.is_empty() {
            return Ok(vec![]);
        }
        let args = ["diff-tree", "-r", "-z", "-C", "--no-rename-empty"];
        let only = ["--diff-filter=CR", "--name-status", &of.tree, &now.tree];
        let all = split(self.read(&[&args[..], &only].concat())?)?;
        Ok((all.as_chunks::<3>().0.iter())
            .filter(|[_, from, _]| paths.contains(from))
            .map(|[_, _, to]| to.clone())
            .collect())
    }

    /// `target` with each of `theirs` as its own capture has it, and those that one has a file for.
    pub(super) fn with(
        &self,
        target: &Shot,
        theirs: &BTreeMap<&String, &Shot>,
    ) -> io::Result<(Shot, BTreeSet<String>)> {
        let (mut put, mut lines) = (BTreeSet::new(), String::new());
        let mut modes = self.modes(target)?;
        for (path, shot) in theirs {
            let entry = split(self.read(&["ls-tree", "-z", &shot.tree, "--", path.as_str()])?)?;
            let Some(entry) = entry.first().filter(|e| e.contains(" blob ")) else {
                continue;
            };
            lines += &format!("{entry}\0");
            put.insert(path.to_string());
            let own = self.modes(shot)?.unwrap_or_default();
            match &mut modes {
                Some(modes) => theirs_on(modes, &own, path),
                // The target's own are unknown, and only those that are would be put back.
                None if own.contains_key(*path) => {
                    return Err(io::Error::other("its permissions would be lost"));
                }
                None => {}
            }
        }
        if put.is_empty() {
            return Ok((target.clone(), put));
        }
        let _one = self.lock()?;
        let index = self.git.join("edits.index");
        // Only one cut short leaves these, and the lock says none is running.
        let _ = fs::remove_file(self.git.join("edits.index.lock"));
        self.run(&index, &["read-tree", &target.tree])?;
        let add = ["update-index", "--add", "--replace", "-z", "--index-info"];
        fed(self.store(&index, &add), "update-index", Some(&lines))?;
        let tree = String::from_utf8_lossy(&self.run(&index, &["write-tree"])?)
            .trim()
            .to_string();
        fs::remove_file(index)?;
        let modes = modes.map(|m| self.save_modes(&m)).transpose()?;
        let target = target.clone();
        Ok((
            Shot {
                tree,
                modes,
                ..target
            },
            put,
        ))
    }
}

/// The user's permissions of `path`; its folders get back no more than either moment gave them.
fn theirs_on(modes: &mut Modes, own: &Modes, path: &str) {
    modes.remove(path);
    modes.extend(own.get(path).map(|m| (path.to_string(), *m)));
    for (i, _) in path.match_indices('/') {
        let dir = &path[..=i];
        if let Some(mode) = own.get(dir) {
            let mode = modes.get(dir).unwrap_or(&0o755) & mode;
            modes.insert(dir.into(), mode);
        }
    }
}
