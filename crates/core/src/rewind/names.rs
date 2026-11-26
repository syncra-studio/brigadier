//! Names on a disk that takes two letter cases for one [D26]: a capture keeps each as the disk
//! spells it, so a rename that changes only its case goes back like any other.

use super::snap::{CHUNK, Store, done, split};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::os::unix::fs::{DirEntryExt, MetadataExt};
use std::path::Path;

impl Store {
    /// Which file is at `path`, whatever its name's spelling.
    pub(super) fn file(&self, path: &str) -> Option<(u64, u64)> {
        let m = fs::symlink_metadata(self.cwd().join(path)).ok()?;
        Some((m.dev(), m.ino()))
    }

    /// Whether the disk takes two letter cases for one, as a name in the folder tells, read only:
    /// the folder's own path may run through a disk that does where the folder's doesn't.
    pub(super) fn folds(&self) -> bool {
        let names: BTreeSet<String> = (fs::read_dir(self.cwd()).into_iter().flatten().flatten())
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        let flip = |c: char| match c.is_ascii_lowercase() {
            true => c.to_ascii_uppercase(),
            false => c.to_ascii_lowercase(),
        };
        let other = (names.iter())
            .find_map(|n| Some(n.chars().map(flip).collect::<String>()).filter(|o| o != n));
        let Some(other) = other else {
            // No name with a letter to ask by: the folder's path is all there is.
            let there = self.file("");
            return there.is_some()
                && there == self.file(&self.cwd().to_string_lossy().to_uppercase());
        };
        !names.contains(&other) && self.file(&other).is_some()
    }

    /// `path` as the disk spells it, only its letter case ever apart; None where nothing is there.
    pub(super) fn spelled(&self, path: &str) -> Option<String> {
        let (mut at, mut out) = (self.cwd().to_path_buf(), vec![]);
        for part in path.split('/') {
            let there = fs::symlink_metadata(at.join(part)).ok()?;
            let (mut name, lower) = (part.to_string(), part.to_lowercase());
            for e in fs::read_dir(&at).into_iter().flatten().flatten() {
                let entry = e.file_name().to_string_lossy().into_owned();
                if entry == part {
                    name = entry;
                    break;
                }
                if e.ino() == there.ino() && entry.to_lowercase() == lower {
                    name = entry;
                }
            }
            at.push(&name);
            out.push(name);
        }
        Some(out.join("/"))
    }

    /// Gives the index the disk's spelling where git kept another letter case.
    pub(super) fn respell(&self, index: &Path) -> io::Result<()> {
        let exact = ["-c", "core.ignorecase=false"];
        let list = ["ls-files", "-o", "--exclude-standard", "-z"];
        let kept = split(self.run(index, &["ls-files", "-z"])?)?;
        // Git folds only ASCII letters, so it may have one file under two names: the disk's goes back in.
        let ascii = kept.iter().all(|p| p.is_ascii());
        let mut named = BTreeMap::new();
        for path in kept.iter().filter(|_| !ascii) {
            let names: &mut Vec<&String> = named.entry(self.file(path)).or_default();
            names.push(path);
        }
        let one = |(at, names): &(Option<_>, Vec<&String>)| {
            at.is_some() && names.len() > 1 && !names.iter().all(|p| p.is_ascii())
        };
        let twice: Vec<&String> = (named.into_iter().filter(one)).flat_map(|n| n.1).collect();
        self.each(index, &["update-index", "--force-remove"], &twice)?;
        // Everything else is in the index by now, but for what it has under another spelling.
        let mut new = split(self.run(index, &[&exact[..], &list].concat())?)?;
        // One that's ignored too, though the project has it.
        for chunk in twice.chunks(CHUNK) {
            let mut disk = self.store(
                index,
                &[&exact[..], &["ls-files", "-o", "-z", "--"]].concat(),
            );
            disk.args(chunk);
            new.extend(split(done(disk, "ls-files")?)?);
        }
        if new.is_empty() {
            return Ok(());
        }
        let kept: BTreeMap<String, &String> = kept.iter().map(|p| (p.to_lowercase(), p)).collect();
        // One taken out above that the disk has under that very spelling is its own file, as a hard
        // link's is, or on a disk that tells letter cases apart.
        let own: BTreeSet<&String> = twice.iter().copied().collect();
        let (old, new): (Vec<&String>, Vec<&String>) = (new.iter())
            .filter_map(|p| {
                let old = own.get(p).or(kept.get(&p.to_lowercase()))?;
                Some((*old, p))
            })
            .filter(|(old, p)| self.file(old).is_some() && self.file(old) == self.file(p))
            .unzip();
        self.each(index, &["update-index", "--force-remove"], &old)?;
        self.each(index, &[&exact[..], &["add", "-f"]].concat(), &new)
    }

    /// Spells `path`, just written, as it's named, where the disk still has the letter case that one
    /// of `paths` had: a folder that holds more than them keeps it.
    pub(super) fn spell(&self, path: &str, paths: &BTreeSet<String>) -> io::Result<()> {
        let Some(there) = (self.spelled(path)).filter(|t| t != path && paths.contains(t)) else {
            return Ok(());
        };
        let mut at = self.cwd().to_path_buf();
        for (is, named) in there.split('/').zip(path.split('/')) {
            if is != named {
                fs::rename(at.join(is), at.join(named))?;
            }
            at.push(named);
        }
        Ok(())
    }

    /// What of `wanted` can be written, and what stays: what's blocked, and what would take files
    /// `wanted` doesn't name along as its folder gets its own letter case back.
    pub(super) fn open(&self, wanted: &BTreeSet<String>) -> (BTreeSet<String>, BTreeSet<String>) {
        let (mut paths, mut held) = (wanted.clone(), BTreeMap::new());
        loop {
            let mut stay: BTreeSet<String> = (paths.iter())
                .filter(|p| self.blocked(p, &paths) || self.moves(p, &paths, &mut held))
                .cloned()
                .collect();
            if stay.is_empty() {
                return (paths.clone(), wanted.difference(&paths).cloned().collect());
            }
            // What's there under another letter case is its file, which stays too.
            let cased: Vec<String> = stay.iter().filter_map(|p| self.spelled(p)).collect();
            stay.extend(cased);
            paths.retain(|p| !stay.contains(p));
        }
    }

    /// Whether `spell` would rename a folder that holds a file `paths` doesn't name; one the project
    /// ignores goes with its folder. `held`: what each such folder holds.
    fn moves(
        &self,
        path: &str,
        paths: &BTreeSet<String>,
        held: &mut BTreeMap<String, Option<Vec<String>>>,
    ) -> bool {
        let Some((dir, name)) = path.rsplit_once('/') else {
            return false;
        };
        let Some(home) = self.spelled(dir).filter(|home| home != dir) else {
            return false;
        };
        let there = self.spelled(path).unwrap_or(format!("{home}/{name}"));
        if !paths.contains(&there) {
            return false;
        }
        let same = (home.split('/').zip(dir.split('/'))).take_while(|(is, named)| is == named);
        let top: Vec<&str> = home.split('/').take(same.count() + 1).collect();
        let top = top.join("/");
        let all = held
            .entry(top)
            .or_insert_with_key(|top| self.holding(top).ok());
        let Some(all) = all else {
            return true;
        };
        all.iter().any(|p| !paths.contains(p))
    }

    /// The files in `dir` that the project doesn't ignore, as the disk spells them.
    fn holding(&self, dir: &str) -> io::Result<Vec<String>> {
        let list = ["ls-files", "-c", "-o", "--exclude-standard", "-z", "--"];
        let dir = format!(":(literal){dir}");
        let args = [&["-c", "core.ignorecase=false"], &list[..], &[&dir]].concat();
        let mut all = split(self.source(&args)?)?;
        all.retain(|p| self.spelled(p).as_ref() == Some(p));
        Ok(all)
    }
}
