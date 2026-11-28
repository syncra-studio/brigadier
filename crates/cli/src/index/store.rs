//! What a pass stores of each session as it reads it: its text, fold and title together.

use super::{Entry, Row, row};
use brigadier_core as core;
use rusqlite::{Connection, params};
use std::path::Path;

/// A replaced log's old text and the stored fold past it go together, so a stop between keeps
/// neither.
pub(super) fn reset(db: &mut Connection, id: &str) -> rusqlite::Result<()> {
    let tx = db.transaction()?;
    tx.execute("DELETE FROM text WHERE id=?1", params![id])?;
    tx.execute(
        "UPDATE sessions SET folded=NULL, title='' WHERE id=?1",
        params![id],
    )?;
    tx.commit()
}

fn insert(q: &mut rusqlite::CachedStatement, id: &str, r: Row) -> rusqlite::Result<()> {
    let (at, src, ts, body, files) = r;
    q.execute(params![id, at, src, ts as i64, body, files])
        .map(|_| ())
}

/// Folds what a session's log added, each word going into search as it's read, so a cold rebuild
/// holds no more than a row at a time [D176]. Its text, fold and title commit together, and only
/// with a clean fold.
pub(super) fn fold_into(
    db: &mut Connection,
    id: &str,
    dir: &Path,
    e: &mut Entry,
    len: u64,
    keep: bool,
) -> rusqlite::Result<()> {
    let tx = db.transaction()?;
    // Parsed once, not per row: a cold rebuild inserts millions [D52].
    let mut q = tx.prepare_cached(
        "INSERT INTO text(id, at, src, ts, body, files) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    let mut stored = Ok(());
    // A fork's inherited copy goes in with its first pass.
    // shortcut: read whole, as a rewind's archive below is; both are one session's, rare and
    // smaller than its log. Stream them if a fork of a huge session shows up in a profile.
    if e.done.pos == 0 {
        for r in core::archive::inherited(dir) {
            stored = stored.and_then(|_| insert(&mut q, id, row(r)));
        }
    }
    let mut title = e.title.clone();
    let mut rewound = false;
    let mut summary = (e.done.fold.turns.first()).is_some_and(|t| t.origin == "summary");
    let folded = core::fold_from(dir, e.done.clone(), |item| {
        rewound |= item["kind"] == "note" && item["event"] == "rewound";
        let skip = core::archive::summary(item, &mut summary);
        let entry = core::archive::entry(item, core::archive::at(item));
        if let Some(entry) = entry.filter(|_| !skip && stored.is_ok()) {
            if entry.from == "user" && title.is_empty() {
                title = crate::title::from(&entry.text);
            }
            stored = insert(&mut q, id, row(entry));
        }
    });
    stored?;
    e.seen_len = len;
    match folded {
        Ok(f) if f.norm.clean() => {
            // A rewind takes its dropped words out of search, however late it's read.
            if rewound {
                tx.execute("DELETE FROM text WHERE id=?1", params![id])?;
                for r in core::archive::read(dir).unwrap_or_default() {
                    insert(&mut q, id, row(r))?;
                }
            }
            drop(q);
            let blob = serde_json::to_vec(&f).unwrap_or_default();
            tx.execute(
                "INSERT INTO sessions(id, title, folded) VALUES(?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET title=?2, folded=?3",
                params![id, title, blob],
            )?;
            tx.commit()?;
            // For this process's later reads; a one-shot rebuild has none.
            if keep {
                core::keep(dir, &f);
            }
            e.title = title;
            e.done = f;
            e.ahead = None;
            e.error = None;
        }
        // Ended mid-line, or unreadable: nothing of it stored, the next pass reads it again.
        Ok(f) => e.ahead = Some(f),
        Err(err) => e.error = Some(err.to_string()),
    }
    Ok(())
}
