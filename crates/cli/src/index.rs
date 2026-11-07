//! The session list in SQLite [D67]: `index.db`, kept off the write path by whoever holds
//! `daemon.lock`, and always rebuildable from the logs. Search is FTS5 over user inputs and
//! assistant text, whole words and word starts [D72].

use crate::owner;
use brigadier_core::fold::{self, Owner};
use brigadier_core::{self as core, Folded, norm};
use brigadier_frames::{log, procs, take_lock};
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Bumped with any change to the tables. Together with the normaliser's version it decides
/// whether `index.db` is still ours, or is deleted and rebuilt from the logs.
const SCHEMA: i64 = 1;
const TITLE_CHARS: usize = 80;
/// Longer than the watchdog's TERM, wait, KILL, wait (2 s), so it always goes first.
const SWEEP_AFTER_MS: u64 = 3_000;

fn version() -> i64 {
    SCHEMA * 1000 + norm::VERSION as i64
}

fn db_err(e: rusqlite::Error) -> io::Error {
    io::Error::other(format!("index: {e}"))
}

#[derive(Default)]
struct Entry {
    /// The last clean fold, the one stored and resumed from.
    done: Folded,
    /// A fold past `done` that ended mid-line: good for status, never stored.
    ahead: Option<Folded>,
    title: String,
    seen_len: u64,
    error: Option<String>,
    orphaned_since: Option<u64>,
}

pub struct Index {
    db: Connection,
    data: PathBuf,
    entries: BTreeMap<String, Entry>,
    pub rows: BTreeMap<String, Value>,
}

impl Index {
    /// Opens `index.db`, or deletes and recreates it when it's missing, `cold`, or another version.
    pub fn open(data: &Path, cold: bool) -> io::Result<Index> {
        let path = data.join("index.db");
        let stale = cold
            || Connection::open(&path)
                .and_then(|db| db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)))
                .map_or(true, |v| v != version());
        if stale {
            for ext in ["", "-wal", "-shm"] {
                match fs::remove_file(format!("{}{ext}", path.display())) {
                    Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                    _ => {}
                }
            }
        }
        let db = Connection::open(&path).map_err(db_err)?;
        // Rebuildable, so losing the last commits on power loss costs nothing [D67].
        db.execute_batch(&format!(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, title TEXT, state TEXT,
               backend TEXT, updated INTEGER, items INTEGER, folded BLOB);
             CREATE VIRTUAL TABLE IF NOT EXISTS text USING fts5(id UNINDEXED, body, tokenize='unicode61');
             PRAGMA user_version={};",
            version()
        ))
        .map_err(db_err)?;
        let entries = load(&db).map_err(db_err)?;
        Ok(Index {
            db,
            data: data.to_path_buf(),
            entries,
            rows: BTreeMap::new(),
        })
    }

    /// One pass: folds what each log added, works out every session's status, sweeps what a dead
    /// host left running, and writes the changes in one short transaction. Returns the rows that
    /// changed and the ids that are gone.
    pub fn sync(&mut self) -> io::Result<(Vec<Value>, Vec<String>)> {
        let all = procs::all();
        let ids = core::ids(&self.data);
        let gone: Vec<String> = self
            .entries
            .keys()
            .filter(|id| ids.binary_search(id).is_err())
            .cloned()
            .collect();
        let (mut changed, mut commits, mut resets) = (vec![], vec![], vec![]);
        for id in ids.iter().filter(|id| core::check_id(id).is_ok()) {
            let dir = core::session_dir(&self.data, id);
            let meta = fs::metadata(dir.join("log")).ok();
            let len = meta.as_ref().map_or(0, |m| m.len());
            let updated = meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as u64);
            let e = self.entries.entry(id.clone()).or_default();
            if len < e.done.pos {
                *e = Entry::default(); // the log was replaced: start over, old text included
                resets.push(id.clone());
            }
            if len != e.seen_len {
                let mut texts = vec![];
                let mut title = e.title.clone();
                let folded = core::fold_from(&dir, e.done.clone(), |item| {
                    let user = item["kind"] == "input" && item["origin"] == "user";
                    if user || item["kind"] == "text" {
                        let text = item["text"].as_str().unwrap_or("");
                        if user && title.is_empty() {
                            title = text
                                .lines()
                                .next()
                                .unwrap_or("")
                                .chars()
                                .take(TITLE_CHARS)
                                .collect();
                        }
                        texts.push(text.to_string());
                    }
                });
                e.seen_len = len;
                match folded {
                    Ok(f) if f.norm.clean() => {
                        e.title = title;
                        e.done = f;
                        e.ahead = None;
                        e.error = None;
                        commits.push((id.clone(), texts));
                    }
                    Ok(f) => e.ahead = Some(f),
                    Err(err) => e.error = Some(err.to_string()),
                }
            }
            let f = e.ahead.as_ref().unwrap_or(&e.done);
            let live = fold::live(&f.fold, owner::state(&self.data, id), &self.data, &all);
            let state = match &e.error {
                Some(_) => "error".into(),
                None => fold::status(&f.fold, &live)["state"].clone(),
            };
            // A dead host's groups the watchdog didn't stop, checked by start time [D60].
            let now = log::now_ms();
            if live.owner == Owner::Dead && live.orphans > 0 {
                let since = *e.orphaned_since.get_or_insert(now);
                // Holding the session's lock keeps a host from starting and adopting them mid-sweep.
                if now - since >= SWEEP_AFTER_MS
                    && let Ok(Some(_lock)) = take_lock(&dir.join("owner.lock"))
                {
                    core::sweep(&f.fold);
                    e.orphaned_since = None;
                }
            } else {
                e.orphaned_since = None;
            }
            let row = json!({"id": id, "title": e.title, "state": state, "backend": f.fold.backend,
                             "updated": updated, "items": f.fold.items, "error": e.error});
            if self.rows.get(id) != Some(&row) {
                self.rows.insert(id.clone(), row.clone());
                changed.push(row);
            }
        }
        for id in &gone {
            self.entries.remove(id);
            self.rows.remove(id);
        }
        if let Err(e) = self.write(&changed, &commits, &resets, &gone) {
            // Nothing of this pass was stored: carry on from what was, so the next pass redoes it.
            self.entries = load(&self.db).map_err(db_err)?;
            self.rows.clear();
            return Err(db_err(e));
        }
        Ok((changed, gone))
    }

    fn write(
        &mut self,
        changed: &[Value],
        commits: &[(String, Vec<String>)],
        resets: &[String],
        gone: &[String],
    ) -> rusqlite::Result<()> {
        if changed.is_empty() && commits.is_empty() && resets.is_empty() && gone.is_empty() {
            return Ok(());
        }
        let tx = self.db.transaction()?;
        for row in changed {
            tx.execute(
                "INSERT INTO sessions(id, title, state, backend, updated, items) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET title=?2, state=?3, backend=?4, updated=?5, items=?6",
                params![row["id"].as_str(), row["title"].as_str(), row["state"].as_str(),
                        row["backend"].as_str(), row["updated"].as_i64(), row["items"].as_i64()],
            )?;
        }
        for id in resets {
            tx.execute("DELETE FROM text WHERE id=?1", params![id])?;
        }
        for (id, texts) in commits {
            let blob = serde_json::to_vec(&self.entries[id].done).unwrap_or_default();
            tx.execute(
                "UPDATE sessions SET folded=?2 WHERE id=?1",
                params![id, blob],
            )?;
            for text in texts {
                tx.execute(
                    "INSERT INTO text(id, body) VALUES(?1, ?2)",
                    params![id, text],
                )?;
            }
        }
        for id in gone {
            tx.execute("DELETE FROM sessions WHERE id=?1", params![id])?;
            // shortcut: `id` isn't indexed in the FTS table, so this scans it; fine while deletes
            // are rare, add a rowid map if they show up in a profile.
            tx.execute("DELETE FROM text WHERE id=?1", params![id])?;
        }
        tx.commit()
    }
}

/// Each session's stored fold and title: where the next pass carries on from.
fn load(db: &Connection) -> rusqlite::Result<BTreeMap<String, Entry>> {
    let mut q = db.prepare("SELECT id, title, folded FROM sessions")?;
    let rows = q.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<Vec<u8>>>(2)?,
        ))
    })?;
    let mut entries = BTreeMap::new();
    for row in rows {
        let (id, title, folded) = row?;
        let done = folded
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let entry = Entry {
            done,
            title,
            ..Default::default()
        };
        entries.insert(id, entry);
    }
    Ok(entries)
}

/// Session ids whose text holds every word, each as a whole word or a word start. Its own
/// read-only connection and a single statement, so no read transaction stays open.
pub fn search(data: &Path, q: &str) -> io::Result<Vec<String>> {
    let terms: Vec<String> = q
        .split_whitespace()
        .map(|w| format!("\"{}\"*", w.replace('"', "\"\"")))
        .collect();
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let db = Connection::open_with_flags(data.join("index.db"), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(db_err)?;
    // Each word may sit in a different message of the same session.
    let one = "SELECT id FROM text WHERE text MATCH ?";
    let inner = vec![one; terms.len()].join(" INTERSECT ");
    let sql = format!("SELECT DISTINCT id FROM ({inner}) LIMIT 500");
    let mut stmt = db.prepare(&sql).map_err(db_err)?;
    stmt.query_map(rusqlite::params_from_iter(&terms), |r| r.get(0))
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(db_err)
}
