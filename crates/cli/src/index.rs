//! The session list in SQLite [D67]: `index.db`, kept off the write path by whoever holds
//! `daemon.lock`, and always rebuildable from the logs. Search is FTS5 over user inputs and
//! assistant text, whole words and word starts [D72].

use crate::owner;

mod find;
mod marks;
mod search;
use brigadier_core::fold::{self, Owner};
use brigadier_core::{self as core, Folded, adapters, projects};
use brigadier_frames::{log, procs, take_lock};
pub use find::find;
use marks::Marks;
use rusqlite::{Connection, params};
pub use search::search;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{fs, io};

/// Bumped with any change to the tables. Together with the normaliser's version it decides
/// whether `index.db` is still ours, or is deleted and rebuilt from the logs.
/// 3: titles follow the short local rule [D186], so older indexes rebuild them.
/// 4: `sessions.archived`, so search puts archived sessions last [D197].
/// 5: every archive entry with its reference, sender, time and files, for agents' search [D103].
/// 6: the user's answers to an agent's questions, so older ones are found too [D75].
const SCHEMA: i64 = 6;
/// Longer than the watchdog's TERM, wait, KILL, wait (2 s), so it always goes first.
const SWEEP_AFTER_MS: u64 = 3_000;

fn version() -> i64 {
    // The fold's own version too: a checkpoint of another one replays every item [C40].
    SCHEMA * 1000 + core::FOLDED as i64
}

pub(crate) fn db_err(e: rusqlite::Error) -> io::Error {
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
    /// Its `session.json`, read again when the folder changes: a level pick renames it in [D30].
    spec: Option<core::Spec>,
    /// Small session files, read again only when the folder changes.
    marks: Marks,
    /// Other sessions' messages its agent hasn't got yet, read again only when their folder changes.
    held: (Option<SystemTime>, Vec<Value>),
    /// At rest, what its row was worked out from: the log's length, its folder's time, its inbox's.
    rest: Option<(u64, Option<SystemTime>, Option<SystemTime>)>,
}

type Row = (String, &'static str, u64, String, String);

/// An archive entry as the index keeps it: reference, sender, time, words, files.
fn row(e: core::archive::Entry) -> Row {
    let text = match e.who.is_empty() {
        true => e.text,
        false => format!("{} {}", e.who, e.text),
    };
    (e.at, e.from, e.ts, text, e.files.join(" "))
}

/// When a folder last changed (ms), or 0.
pub fn touched(dir: &Path) -> u64 {
    fs::metadata(dir)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

pub struct Index {
    db: Connection,
    data: PathBuf,
    entries: BTreeMap<String, Entry>,
    /// Each session folder's repository, asked of git once [D165].
    roots: projects::Roots,
    /// The projects the rows were last worked out with.
    projects: Vec<projects::Project>,
    pub rows: BTreeMap<String, Value>,
    /// The sessions the last pass looked at: all of them in a full one, else those not at rest.
    pub looked: BTreeSet<String>,
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
               backend TEXT, updated INTEGER, items INTEGER, folded BLOB, archived INTEGER NOT NULL DEFAULT 0);
             CREATE VIRTUAL TABLE IF NOT EXISTS text USING fts5(id UNINDEXED, at UNINDEXED, src UNINDEXED,
               ts UNINDEXED, body, files, tokenize='unicode61');
             PRAGMA user_version={};",
            version()
        ))
        .map_err(db_err)?;
        let entries = load(&db).map_err(db_err)?;
        Ok(Index {
            db,
            data: data.to_path_buf(),
            entries,
            roots: projects::Roots::default(),
            projects: vec![],
            rows: BTreeMap::new(),
            looked: BTreeSet::new(),
        })
    }

    /// One pass: folds what each log added, works out every session's status, sweeps what a dead
    /// host left running, and writes the changes in one short transaction. Returns the rows that
    /// changed and the ids that are gone. Unless `full`, a session at rest is skipped until its log,
    /// folder or inbox changes: nothing runs in it, waits on a clock or on another session. What
    /// shows in none of those (its host's end, a setting) waits for the next full pass.
    pub fn sync(&mut self, full: bool) -> io::Result<(Vec<Value>, Vec<String>)> {
        let all = procs::all();
        let ids = core::ids(&self.data);
        let projects = projects::list(&self.data).unwrap_or_default();
        let full = full || projects != self.projects;
        self.looked.clear();
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
            let time = |p: &Path| fs::metadata(p).and_then(|m| m.modified()).ok();
            // Read before all else, so a change meanwhile shows in the next pass.
            let key = (len, time(&dir), time(&dir.join("peers/in")));
            let e = self.entries.entry(id.clone()).or_default();
            if !full && e.rest == Some(key) {
                continue;
            }
            self.looked.insert(id.clone());
            if len < e.done.pos {
                *e = Entry::default(); // the log was replaced: start over, old text included
                resets.push(id.clone());
            }
            if len != e.seen_len {
                // A fork's inherited copy goes in with its first pass.
                let mut texts: Vec<Row> = match e.done.pos {
                    0 => core::archive::inherited(&dir)
                        .into_iter()
                        .map(row)
                        .collect(),
                    _ => vec![],
                };
                let mut title = e.title.clone();
                let mut rewound = false;
                let mut summary =
                    (e.done.fold.turns.first()).is_some_and(|t| t.origin == "summary");
                let folded = core::fold_from(&dir, e.done.clone(), |item| {
                    rewound |= item["kind"] == "note" && item["event"] == "rewound";
                    let skip = core::archive::summary(item, &mut summary);
                    let entry = core::archive::entry(item, core::archive::at(item));
                    if let Some(entry) = entry.filter(|_| !skip) {
                        if entry.from == "user" && title.is_empty() {
                            title = crate::title::from(&entry.text);
                        }
                        texts.push(row(entry));
                    }
                });
                e.seen_len = len;
                match folded {
                    Ok(f) if f.norm.clean() => {
                        // A rewind takes its dropped words out of search, however late it's read.
                        if rewound {
                            texts = core::archive::read(&dir)
                                .unwrap_or_default()
                                .into_iter()
                                .map(row)
                                .collect();
                            resets.push(id.clone());
                        }
                        core::keep(&dir, &f);
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
            let live = fold::live(&f.fold, owner::state(&self.data, id), &dir, &all);
            let status = fold::status(&f.fold, &live);
            let (state, reason) = match &e.error {
                Some(_) => ("error".into(), Value::Null),
                None if fold::quiet(&f.fold, status["state"].as_str().unwrap_or("")) => {
                    ("idle".into(), Value::Null)
                }
                None => (status["state"].clone(), status["reason"].clone()),
            };
            let at = touched(&dir);
            if at != e.marks.at {
                e.marks = Marks::read(&dir, at);
                e.spec = None;
            }
            if key.2 != e.held.0 {
                e.held = (key.2, crate::peers::held::row(&self.data, id));
            }
            let auto = fold::switchable(&f.fold)
                .is_some_and(|why| crate::wants(&self.data, &f.fold.backend, why));
            let holds = crate::workers::holds(&self.data, id, &f.fold, live.child.is_some());
            let worker = crate::workers::row(&dir, state.as_str().unwrap_or(""), &f.fold);
            // A worker's mark says working as its row does.
            let held = holds || worker["kind"] == "working";
            let mark = fold::mark(&f.fold, &live, e.marks.seen, auto, held);
            // No mark for a PR's checks [D174].
            let mark = match mark {
                _ if e.error.is_some() => Some("amber"),
                // Its mockup's news unseen: the blue dot, as a reply's.
                None | Some("background") if e.marks.news > e.marks.seen => Some("unread"),
                m => m,
            };
            // A dead host's groups the watchdog didn't stop, checked by start time [D60].
            let now = log::now_ms();
            if live.owner == Owner::Dead && live.orphans > 0 {
                let since = *e.orphaned_since.get_or_insert(now);
                // Holding the session's lock keeps a host from starting and adopting them mid-sweep.
                if now - since >= SWEEP_AFTER_MS
                    && let Ok(Some(_lock)) = take_lock(&dir.join("owner.lock"))
                {
                    core::sweep(&f.fold, &dir);
                    e.orphaned_since = None;
                }
            } else {
                e.orphaned_since = None;
            }
            let works = e.error.is_none() && fold::works(&f.fold, &live);
            let rests = f.fold.turns.is_empty()
                && f.fold.workers.is_empty()
                && (live.jobs, live.orphans) == (0, 0)
                && live.left.is_empty()
                && mark != Some("working")
                && worker["kind"] != "working";
            e.rest = rests.then_some(key);
            e.spec = e.spec.take().or_else(|| core::load(&self.data, id).ok());
            let project = e
                .spec
                .as_ref()
                .and_then(|s| projects::of(s, &projects, &mut self.roots));
            let title = e.marks.title.as_ref().unwrap_or(&e.title);
            let backend = match f.fold.backend.as_str() {
                "" => e.spec.as_ref().map_or("", |s| s.backend.as_str()),
                b => b,
            };
            let steer = adapters::get(backend).is_some_and(|a| a.can().steer);
            // What the next turn runs at, by the same rule send uses [D129, D166, D225].
            let held = project
                .as_deref()
                .is_some_and(|p| crate::models::held_in(&projects, p));
            let next = e
                .spec
                .as_ref()
                .map(|s| (s, adapters::get(crate::models::next_agent(s, &f.fold))));
            let (levels, level) = match next {
                Some((s, Some(a))) => (json!(a.can().levels), core::level(s, a, held)),
                _ => (json!([]), Ok(None)),
            };
            let run = e
                .spec
                .as_ref()
                .map(|s| core::as_run(s, &f.fold, backend, None));
            let mut row = json!({"id": id, "title": title, "pinned": e.marks.pinned, "touched": e.marks.at, "state": state, "reason": reason, "mark": mark,
                             "notice": e.error.is_none().then(|| fold::notice(&f.fold, state.as_str().unwrap_or(""))).flatten(),
                             "resets": f.fold.resets, "sent": f.fold.sent, "finished": f.fold.finished, "backend": backend,
                             "updated": updated, "items": f.fold.items, "error": e.error, "works": works,
                             "switchable": fold::switchable(&f.fold), "account": f.fold.accounts.get(&f.fold.backend).filter(|a| !core::gone(&self.data, a)),
                             "project": project, "model": run.as_ref().and_then(|s| s.model.as_ref()),
                             "archived": e.marks.archived, "lifecycle": e.marks.lifecycle,
                             "effort": run.as_ref().and_then(|s| s.effort.as_ref()), "fast": run.as_ref().is_some_and(|s| s.fast), "picked": f.fold.picked, "setup_op": f.fold.setup_op,
                             "queue": e.marks.queue, "steer": steer, "prs": e.marks.prs, "pr": e.marks.pr,
                             // A turn whose host is gone has nothing left to stop or queue behind [D60].
                             "running": !f.fold.turns.is_empty() && !matches!(state.as_str(), Some("interrupted" | "undelivered")),
                             "levels": levels, "level": level.as_ref().ok(), "level_refused": level.as_ref().err(), "held": held,
                             "level_op": e.spec.as_ref().and_then(|s| s.level_op.as_ref()), "forkOf": e.spec.as_ref().and_then(|s| s.fork_of.as_ref()),
                             // Its last turn was the user's Stop: Send and the queue offer Resume [D373, D2004].
                             "resumable": fold::resumable(&f.fold, state.as_str().unwrap_or("")),
                             // Where it works: its worktree, else the project's folder; a chat's own scratch folder is none [D348, D2022].
                             "folder": e.spec.as_ref().map(|s| &s.cwd).filter(|cwd| Path::new(cwd) != core::session_dir(&self.data, id).join("scratch")),
                             "worker": worker,
                             "stalled": f.fold.last.as_ref().filter(|_| core::rebirth::stalled(&f.fold)).map(|l| &l["id"])}); // the turn the loop guard stopped: its line offers Continue [D144]
            // A worker's images, which its parent's thread shows too [D289].
            row["images"] = json!(f.fold.images);
            // Waiting till its record moves on, or its sender is deleted: the thread's waiting bubbles.
            let waits = |m: &&Value| crate::peers::held::kept(&self.data, m);
            row["arriving"] = json!(e.held.1.iter().filter(waits).collect::<Vec<_>>());
            row["news"] = e.marks.news.into(); // its mockup's news, read once seen as late [D560]
            row["labels"] = e.marks.labels.clone(); // its labels [D3101, D3103]
            row["plan"] = f.fold.plan.shown(); // its agent's to-do list and what it finished, the summary card's Plan [D144]
            row["woke"] = json!(fold::woke(&f.fold)); // woke itself after a Stop or Pause: stopped again [D95]
            // Using the computer now: holding its lock, its turn running, not waiting on the user [D907, D957].
            row["computer"] = json!(
                row["running"] == true && state != "waiting_answer" && crate::computer::holds(id)
            );
            row["holding"] = holds.into(); // answered, its block open on its subagents or workers: a message waits or steers [D521]
            row["unchecked"] = json!(f.fold.unchecked()); // its check gave no verdict: it asks, then back [D455]
            row["child"] = live.child.is_some().into(); // its agent's process is up: a finished worker's idle one is closed
            fold::background_row(&mut row, &dir, &live);
            crate::overnight::row(&self.data, &mut row, &e.marks.overnight, f.fold.finished);
            // It holds its project's own folder: Local checkout can't start there again [D306].
            row["local"] = json!(core::share::holds_local(e.spec.as_ref(), &projects));
            row["noteChat"] = json!(e.spec.as_ref().is_some_and(|s| s.opts.contains_key("note"))); // in its note's tab, not the sidebar [D281]
            row["limits"] = json!(f.fold.limits); // its CLI's newest usage report, for the store [D2039]
            // A summary turn's end, which `finished` leaves out: the daemon's turn-end work sees it.
            let summary = (f.fold.last.as_ref()).filter(|l| l["origin"] == "summary");
            row["summarized"] = json!(summary.map(|l| &l["ts"]));
            row["context"] = json!(f.fold.context); // how full its context is; a rebirth due now below [D88, D108]
            // A cut's input lost before its CLI read it, or a summary turn whose host died: the new
            // host ends that one failed, never sent again, and the renewal goes ahead [rev 3 §2.2].
            let first = f.fold.turns.first();
            let lost = (state == "undelivered" && first.is_some_and(|t| t.switch["why"] == "cut"))
                || (state == "interrupted" && first.is_some_and(|t| t.origin == "summary"));
            let due = e.spec.as_ref().and_then(|s| core::rebirth::due(s, &f.fold));
            row["rebirth"] = json!(due.or(lost.then_some("cut")));
            // A turn the network cut, resumed by itself once its agent's API answers [D339].
            let back = fold::reconnect(&f.fold, false).filter(|_| state == "reconnecting");
            row["reconnect"] = json!(back.map(|mut r| {
                let a = adapters::get(r["backend"].as_str().unwrap_or(backend));
                r["host"] = json!(a.and_then(|a| a.api_host()));
                r
            }));
            // A chat at its usage limit carries on by itself at the reset, or says why not [C34, C54].
            row["reset"] = json!((e.spec.as_ref()).and_then(|s| {
                crate::accounts::reset::row(&self.data, s, &f.fold, !row["worker"].is_null())
            }));
            // Being stopped for one, or its fresh conversation not yet under way: the composer says so [D112].
            // A cut for a model picked mid-turn is no rebirth [D124].
            let cut = f.fold.cut.as_deref().filter(|_| !f.fold.switched);
            // The user's Continue, till its fresh conversation starts.
            let last = f.fold.last.as_ref().filter(|_| f.fold.turns.is_empty());
            let going = last.is_some_and(|l| f.fold.go_on.as_deref() == l["id"].as_str());
            row["optimizing"] = json!(
                going
                    || f.fold.turns.first().is_some_and(|t| cut == Some(&t.id)
                        || (!t.began
                            && matches!(t.switch["why"].as_str(), Some("rebirth" | "cut"))))
            );
            if self.rows.get(id) != Some(&row) {
                self.rows.insert(id.clone(), row.clone());
                changed.push(row);
            }
        }
        self.projects = projects;
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
        commits: &[(String, Vec<Row>)],
        resets: &[String],
        gone: &[String],
    ) -> rusqlite::Result<()> {
        if changed.is_empty() && commits.is_empty() && resets.is_empty() && gone.is_empty() {
            return Ok(());
        }
        let tx = self.db.transaction()?;
        for row in changed {
            tx.execute(
                "INSERT INTO sessions(id, title, state, backend, updated, items, archived) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET title=?2, state=?3, backend=?4, updated=?5, items=?6, archived=?7",
                // A row says it's archived once archive exists (1v); until then every row is active.
                params![row["id"].as_str(), row["title"].as_str(), row["state"].as_str(),
                        row["backend"].as_str(), row["updated"].as_i64(), row["items"].as_i64(),
                        !matches!(row["archived"], Value::Null | Value::Bool(false))],
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
            // Parsed once, not per row: a cold rebuild inserts millions [D52].
            let mut insert = tx.prepare_cached(
                "INSERT INTO text(id, at, src, ts, body, files) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for (at, src, ts, body, files) in texts {
                insert.execute(params![id, at, src, *ts as i64, body, files])?;
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

/// `index [--cold]`: the index brought up to date, or built afresh.
pub fn rebuild(data: &Path, cold: bool) -> io::Result<Value> {
    let started = std::time::Instant::now();
    // The daemon keeps the index while it runs; a second writer would only fight it.
    let Some(_lock) = take_lock(&data.join("daemon.lock"))? else {
        return Err(io::Error::other(
            "the daemon is running and keeps the index",
        ));
    };
    let mut ix = Index::open(data, cold)?;
    ix.sync(true)?;
    Ok(json!({"ok": true, "sessions": ix.rows.len(), "ms": started.elapsed().as_millis() as u64}))
}
