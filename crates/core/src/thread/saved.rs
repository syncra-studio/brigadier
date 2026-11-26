//! A thread saved as it folds [D503]: each finished turn's rows land in `sessions/<id>/thread/`
//! (a folder of its own, so the session folder's mtime stays the setup watch's [D226]), with the
//! fold's state at that point. An open reads the state and only the rows it sends; the log stays the
//! source [D67]: anything here that doesn't check out is removed and folded again from the log.
//!
//! `rows` holds one JSON row per line, a row edited later again further on; `rows.idx` 20-byte
//! records (`at: u64`, `len: u32`, `index: u32`, `crc: u32` of the line, little-endian), the
//! newest per index winning;
//! `state.json` the rest, vouching for how much of both was whole when it was written, last.

use super::Thread;
use crate::norm::{self, Norm};
use crate::rewind::Active;
use crate::write_atomic;
use brigadier_frames::log::Reader;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::{Cell, OnceCell};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::ops::{Index, IndexMut, Range};
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::Path;
use std::sync::Arc;

const DIR: &str = "thread";
/// Bumped when what's saved changes shape.
const FORMAT: u64 = 2;
/// Where a row only in memory is.
const MEMORY: u64 = u64::MAX;

/// What a saved thread must match to be read back: its format, the normaliser's, and the code that
/// folds it (`build.rs`), so an update that changed any folds again (in the background) rather than
/// show rows an older fold made.
fn version() -> u64 {
    let code: u32 = env!("BRIGADIER_FOLDS").parse().unwrap_or(0);
    FORMAT << 48 | u64::from(norm::VERSION) << 32 | u64::from(code)
}

/// Where saved rows went: index, `at`, `len`, `crc`.
type Placed = Vec<(usize, u64, u32, u32)>;
const RECORD: usize = 20;

#[derive(Clone)]
struct Slot {
    at: u64,
    len: u32,
    crc: u32,
    row: OnceCell<Value>,
}

/// A saved row's line, if it's whole.
fn decode(bytes: &[u8], crc: u32) -> Option<Value> {
    (crc32fast::hash(bytes) == crc)
        .then(|| serde_json::from_slice(bytes).ok())
        .flatten()
}

/// A thread's rows: those saved are read from `rows` when first used. The fold indexes them as it
/// did a list. A row that can't be read reads as null and marks the rows broken: callers check
/// `broken()` after a page or a find, and the thread is then folded again from the log.
#[derive(Default, Clone)]
pub struct Rows {
    slots: Vec<Slot>,
    file: Option<Arc<File>>,
    dirty: BTreeSet<usize>,
    broken: Cell<bool>,
}

impl Rows {
    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    pub fn push(&mut self, row: Value) {
        self.dirty.insert(self.slots.len());
        self.slots.push(Slot {
            at: MEMORY,
            len: 0,
            crc: 0,
            row: OnceCell::from(row),
        });
    }

    pub fn get(&self, at: usize) -> Option<&Value> {
        (at < self.len()).then(|| &self[at])
    }

    pub fn range(
        &self,
        range: Range<usize>,
    ) -> impl DoubleEndedIterator<Item = &Value> + ExactSizeIterator {
        range.map(|at| &self[at])
    }

    pub fn iter(&self) -> impl DoubleEndedIterator<Item = &Value> + ExactSizeIterator {
        self.range(0..self.len())
    }

    pub fn broken(&self) -> bool {
        self.broken.get()
    }

    /// Reads every saved row not read yet in one pass, for a find over them all.
    pub fn read_all(&self) {
        let Some(file) = &self.file else {
            return;
        };
        let end = (self.slots.iter())
            .filter(|s| s.at != MEMORY && s.row.get().is_none())
            .map(|s| s.at + u64::from(s.len))
            .max();
        let Some(end) = end else {
            return;
        };
        let mut all = vec![0; end as usize];
        if file.read_exact_at(&mut all, 0).is_err() {
            return self.broken.set(true);
        }
        for s in (self.slots.iter()).filter(|s| s.at != MEMORY && s.row.get().is_none()) {
            let bytes = &all[s.at as usize..(s.at + u64::from(s.len)) as usize];
            s.row.get_or_init(|| self.decode(decode(bytes, s.crc)));
        }
    }

    /// Lets go of saved rows read so far: they're read again when used.
    pub fn unload(&mut self) {
        for (at, s) in self.slots.iter_mut().enumerate() {
            if s.at != MEMORY && !self.dirty.contains(&at) {
                s.row = OnceCell::new();
            }
        }
    }

    fn decode(&self, row: Option<Value>) -> Value {
        row.unwrap_or_else(|| {
            self.broken.set(true);
            Value::Null
        })
    }

    fn read(&self, s: &Slot) -> Value {
        let row = self.file.as_ref().and_then(|file| {
            let mut bytes = vec![0; s.len as usize];
            file.read_exact_at(&mut bytes, s.at).ok()?;
            decode(&bytes, s.crc)
        });
        self.decode(row)
    }

    /// The rows changed since the last save, as lines starting at `base` and their index records,
    /// and where each went.
    fn unsaved(&self, base: u64) -> io::Result<(Vec<u8>, Vec<u8>, Placed)> {
        let (mut lines, mut records, mut placed) = (vec![], vec![], vec![]);
        for &at in &self.dirty {
            let start = lines.len();
            serde_json::to_writer(&mut lines, &self[at])?;
            let (from, len) = (base + start as u64, (lines.len() - start) as u32);
            let crc = crc32fast::hash(&lines[start..]);
            lines.push(b'\n');
            records.extend_from_slice(&from.to_le_bytes());
            records.extend_from_slice(&len.to_le_bytes());
            records.extend_from_slice(&(at as u32).to_le_bytes());
            records.extend_from_slice(&crc.to_le_bytes());
            placed.push((at, from, len, crc));
        }
        Ok((lines, records, placed))
    }

    fn saved(&mut self, file: File, placed: Placed) {
        for (at, from, len, crc) in placed {
            let s = &mut self.slots[at];
            (s.at, s.len, s.crc) = (from, len, crc);
        }
        self.dirty.clear();
        self.file = Some(Arc::new(file));
    }
}

impl Index<usize> for Rows {
    type Output = Value;

    fn index(&self, at: usize) -> &Value {
        let s = &self.slots[at];
        s.row.get_or_init(|| self.read(s))
    }
}

impl IndexMut<usize> for Rows {
    fn index_mut(&mut self, at: usize) -> &mut Value {
        let _ = &self[at];
        self.dirty.insert(at);
        self.slots[at].row.get_mut().unwrap()
    }
}

/// A thread with the log position it folded to and what folding on needs.
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Saved {
    v: u64,
    pub thread: Thread,
    pos: u64,
    seq: u64,
    norm: Norm,
    active: Active,
    /// The thread's `closed` when last saved, and how much of `rows` and `rows.idx` that vouched for.
    saved: u64,
    rows_len: u64,
    idx_len: u64,
    count: usize,
    /// The log's, so a log made again under the same id folds again.
    inode: u64,
    /// A rewind cut rows already folded, or the log was replaced: fold again from the start.
    #[serde(skip)]
    pub rewound: bool,
}

impl Saved {
    /// The saved thread, or a new one when there's none or it doesn't check out (then removed).
    pub fn load(dir: &Path) -> Saved {
        Saved::read(dir).unwrap_or_else(|| Saved::fresh(dir))
    }

    /// Removes what was saved, for a thread folded again from the log.
    pub fn fresh(dir: &Path) -> Saved {
        let _ = fs::remove_dir_all(dir.join(DIR));
        Saved::default()
    }

    fn read(dir: &Path) -> Option<Saved> {
        let at = dir.join(DIR);
        let mut s: Saved = serde_json::from_slice(&fs::read(at.join("state.json")).ok()?).ok()?;
        let log = fs::metadata(dir.join("log")).ok()?;
        let open = |name| {
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(at.join(name))
        };
        let (rows, idx) = (open("rows").ok()?, open("rows.idx").ok()?);
        let holds = |file: &File, len| file.metadata().is_ok_and(|m| m.len() >= len);
        let fits = s.v == version()
            && s.inode == log.ino()
            && s.pos <= log.len()
            && s.idx_len.is_multiple_of(RECORD as u64)
            && holds(&rows, s.rows_len)
            && holds(&idx, s.idx_len);
        if !fits {
            return None;
        }
        // What a save left half-written past what the state vouches for goes.
        rows.set_len(s.rows_len).ok()?;
        idx.set_len(s.idx_len).ok()?;
        let mut records = vec![0; s.idx_len as usize];
        idx.read_exact_at(&mut records, 0).ok()?;
        let mut slots: Vec<Option<Slot>> = vec![None; s.count];
        for r in records.as_chunks::<RECORD>().0 {
            let at = u64::from_le_bytes(r[..8].try_into().ok()?);
            let len = u32::from_le_bytes(r[8..12].try_into().ok()?);
            let index = u32::from_le_bytes(r[12..16].try_into().ok()?) as usize;
            let crc = u32::from_le_bytes(r[16..].try_into().ok()?);
            if at + u64::from(len) > s.rows_len {
                return None;
            }
            let row = OnceCell::new();
            *slots.get_mut(index)? = Some(Slot { at, len, crc, row });
        }
        s.thread.items = Rows {
            slots: slots.into_iter().collect::<Option<_>>()?,
            file: Some(Arc::new(rows)),
            ..Rows::default()
        };
        Some(s)
    }

    /// Folds what the log gained, and saves when a turn ended since the last save and `save`.
    pub fn advance(&mut self, dir: &Path, save: bool) -> io::Result<()> {
        let log = dir.join("log");
        // A session just made may have no log yet.
        let Ok(meta) = fs::metadata(&log) else {
            return Ok(());
        };
        let cut = self.active.more(dir)?;
        if self.pos > 0 && (cut || meta.ino() != self.inode || meta.len() < self.pos) {
            self.rewound = true;
        }
        if self.rewound {
            return Ok(());
        }
        self.inode = meta.ino();
        let mut reader = Reader::open(&log, self.pos, self.seq)?;
        let mut items = vec![];
        while let Some(frame) = reader.frame()? {
            self.norm.push(&frame, &mut items);
            for item in items.drain(..) {
                // A rewind logged after the scan: what came before it is stale.
                self.rewound |= self.active.newer(frame.seq, &item);
                if self.active.keep(frame.seq, &item) {
                    if item["kind"] == "note" && item["event"] == "forked" {
                        self.thread.inherit(&crate::fork::inherited(dir), &item);
                    }
                    self.thread.push(&item);
                } else {
                    self.thread.dropped(&item);
                }
            }
            // Per frame, so a damaged one later leaves the fold and its place agreeing.
            (self.pos, self.seq) = (reader.pos, reader.seq);
        }
        if save && self.thread.closed > self.saved && !self.rewound && self.norm.clean() {
            self.save(dir)?;
        }
        Ok(())
    }

    /// Appends the rows changed since the last save, then the state that vouches for them. Never
    /// makes the session's folder: a deleted session stays deleted.
    fn save(&mut self, dir: &Path) -> io::Result<()> {
        if self.thread.items.broken() || !dir.join("session.json").exists() {
            return Ok(());
        }
        let at = dir.join(DIR);
        if let Err(e) = fs::create_dir(&at)
            && e.kind() != io::ErrorKind::AlreadyExists
        {
            return Err(e);
        }
        let open = |name| {
            (OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false))
            .open(at.join(name))
        };
        let (rows, idx) = (open("rows")?, open("rows.idx")?);
        let (lines, records, placed) = self.thread.items.unsaved(self.rows_len)?;
        for (file, len, bytes) in [
            (&rows, self.rows_len, &lines),
            (&idx, self.idx_len, &records),
        ] {
            file.set_len(len)?;
            file.write_all_at(bytes, len)?;
            file.sync_data()?;
        }
        self.rows_len += lines.len() as u64;
        self.idx_len += records.len() as u64;
        (self.v, self.count, self.saved) = (version(), self.thread.items.len(), self.thread.closed);
        write_atomic(&at.join("state.json"), &serde_json::to_vec(self)?)?;
        self.thread.items.saved(rows, placed);
        Ok(())
    }
}
