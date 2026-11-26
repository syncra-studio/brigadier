//! Each turn's and each night's record of the folder at its edges, kept in the session's store
//! (`rewind.git/turns`, `rewind.git/nights`) [D35].

use super::GRACE_MS;
use super::snap::{Record, Store};
use crate::fold::Fold;
use crate::{check_id, write_atomic};
use std::fs;
use std::io;
use std::path::PathBuf;

impl Store {
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

    /// Takes the folder as the last turn ended, if `at` is in time. Too late, the edits may be the
    /// user's, not the agent's, and it stays missing: that range offers keep only. `at`: when this
    /// pass began, so a folder chat's earlier repos can't use up a later one's time [D3105].
    pub(super) fn ended(&self, f: &Fold, at: u64) {
        let Some(last) = f.last.as_ref().filter(|_| f.turns.is_empty()) else {
            return;
        };
        let (Some(id), Some(ts)) = (last["id"].as_str(), last["ts"].as_u64()) else {
            return;
        };
        let Some(mut record) = self.load(id).filter(|r| r.end.is_none()) else {
            return;
        };
        if at.saturating_sub(ts) <= GRACE_MS
            && let Ok(end) = self.capture()
        {
            record.end = Some(end);
            let _ = self.save(id, &record);
        }
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

    /// The records of the turns that began between these two moments (ms), oldest first.
    pub(super) fn turns_in(&self, since: u64, at: u64) -> Vec<Record> {
        let mut all = self.records();
        all.retain(|r| r.before.at.is_some_and(|b| since <= b && b <= at));
        all
    }

    fn night_at(&self, since: u64) -> PathBuf {
        self.git.join("nights").join(format!("{since}.json"))
    }

    /// The folder at the two edges of the night that began at `since` (ms).
    pub fn night(&self, since: u64) -> Option<Record> {
        serde_json::from_slice(&fs::read(self.night_at(since)).ok()?).ok()
    }

    pub(super) fn save_night(&self, since: u64, record: &Record) -> io::Result<()> {
        fs::create_dir_all(self.git.join("nights"))?;
        write_atomic(&self.night_at(since), &serde_json::to_vec(record)?)
    }
}
