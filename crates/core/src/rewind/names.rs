//! Names on a disk that takes two letter cases for one [D26]: a capture keeps each as the disk
//! spells it, so a rename that changes only its case goes back like any other.

use super::snap::{Store, split};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::os::unix::fs::{DirEntryExt, MetadataExt};
use std::path::Path;

impl Store {
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
        // Everything is in the index by now, but for what it has under another spelling.
        let new = split(self.run(index, &[&exact[..], &list].concat())?)?;
        if new.is_empty() {
            return Ok(());
        }
        let kept = split(self.run(index, &["ls-files", "-z"])?)?;
        let kept: BTreeMap<String, &String> = kept.iter().map(|p| (p.to_lowercase(), p)).collect();
        let file = |path: &String| {
            let m = fs::symlink_metadata(self.cwd().join(path)).ok()?;
            Some((m.dev(), m.ino()))
        };
        let (old, new): (Vec<&String>, Vec<&String>) = (new.iter())
            .filter_map(|p| Some((*kept.get(&p.to_lowercase())?, p)))
            .filter(|(old, p)| file(old).is_some() && file(old) == file(p))
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
}
