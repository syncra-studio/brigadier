//! Each session's saved thread has one owner [D503]: loading, folding on, saving and folding again
//! from the log happen under its lock, and a delete holds it too, so nothing lands in a session
//! being deleted [D35]. Watches and peeks get a copy to follow, which never saves; the threads
//! last viewed stay in memory, so going back folds only what's new.

use brigadier_core::session_dir;
use brigadier_core::thread::Saved;
use std::collections::{HashMap, VecDeque};
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// How many threads stay in memory, by when they were last viewed.
const RECENT: usize = 8;

type Entry = Arc<Mutex<Option<Saved>>>;

#[derive(Default)]
pub(super) struct Store {
    entries: Mutex<HashMap<String, Entry>>,
    recent: Mutex<VecDeque<String>>,
}

impl Store {
    fn entry(&self, id: &str) -> Entry {
        let mut entries = self.entries.lock().unwrap();
        entries.entry(id.into()).or_default().clone()
    }

    /// The session's thread, folded to the log's end and saved, as a copy to follow.
    pub(super) fn copy(&self, data: &Path, id: &str) -> io::Result<Saved> {
        let entry = self.entry(id);
        let mut held = entry.lock().unwrap();
        let copy = advance(&mut held, &session_dir(data, id))?.clone();
        drop(held);
        self.viewed(id);
        Ok(copy)
    }

    /// Folds on and saves a session whose turn ended, or one never saved; out of memory after,
    /// unless it was viewed lately.
    pub(super) fn catch_up(&self, data: &Path, id: &str) {
        let entry = self.entry(id);
        let mut held = entry.lock().unwrap();
        if let Err(e) = advance(&mut held, &session_dir(data, id)) {
            eprintln!("brigadierd: thread {id}: {e}");
        }
        if !self.recent.lock().unwrap().iter().any(|r| r == id) {
            *held = None;
        }
    }

    /// A saved row couldn't be read: what was saved goes, and the next open folds from the log.
    pub(super) fn invalidate(&self, data: &Path, id: &str) {
        let entry = self.entry(id);
        let mut held = entry.lock().unwrap();
        *held = None;
        Saved::fresh(&session_dir(data, id));
    }

    /// Runs `delete` holding the session's thread, which it then forgets.
    pub(super) fn deleting<T>(&self, id: &str, delete: impl FnOnce() -> T) -> T {
        let entry = self.entry(id);
        let mut held = entry.lock().unwrap();
        let out = delete();
        *held = None;
        out
    }

    fn viewed(&self, id: &str) {
        let mut recent = self.recent.lock().unwrap();
        recent.retain(|r| r != id);
        recent.push_front(id.into());
        while recent.len() > RECENT {
            let old = recent.pop_back().unwrap();
            // One in use is let go by its next catch-up instead.
            if let Some(entry) = self.entries.lock().unwrap().get(&old)
                && let Ok(mut held) = entry.try_lock()
            {
                *held = None;
            }
        }
    }
}

/// Loads the saved thread if it isn't in memory, folds on and saves; a rewind, a replaced log or a
/// row that can't be read folds it again from the log.
fn advance<'a>(held: &'a mut Option<Saved>, dir: &Path) -> io::Result<&'a mut Saved> {
    let saved = held.get_or_insert_with(|| Saved::load(dir));
    saved.advance(dir, true)?;
    if saved.rewound || saved.thread.items.broken() {
        *saved = Saved::fresh(dir);
        saved.advance(dir, true)?;
    }
    saved.thread.settle();
    saved.thread.items.unload();
    Ok(saved)
}
