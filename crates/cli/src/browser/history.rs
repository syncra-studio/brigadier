//! Visits, reloads, search and import, ported from the old browser store.

use super::store::{PAGE_LIMIT, Store, like};
use super::types::*;
use rusqlite::{OptionalExtension, params};

impl Store {
    /// The page at `url` finished loading, with the title it showed while loading, if any. A
    /// reload of the page just shown moves that visit's time (and takes a new title) instead of
    /// adding one. Returns the visit, whose title may arrive later.
    pub fn visit(
        &self,
        last: Option<i64>,
        url: &str,
        title: &str,
        agent: bool,
        at_ms: i64,
    ) -> rusqlite::Result<i64> {
        if let Some(id) = last {
            let same = self
                .db
                .query_row("SELECT url FROM visits WHERE id = ?1", [id], |row| {
                    row.get::<_, String>(0)
                })
                .optional()?
                .is_some_and(|shown| shown == url);
            if same {
                self.db.execute(
                    "UPDATE visits SET at_ms = ?2, title = CASE WHEN ?3 = '' THEN title ELSE ?3 END
                     WHERE id = ?1",
                    params![id, at_ms, title],
                )?;
                return Ok(id);
            }
        }
        self.db.execute(
            "INSERT INTO visits (url, title, at_ms, agent) VALUES (?1, ?2, ?3, ?4)",
            params![url, title, at_ms, agent],
        )?;
        Ok(self.db.last_insert_rowid())
    }

    pub fn titled(&self, id: i64, title: &str) -> rusqlite::Result<()> {
        self.db.execute(
            "UPDATE visits SET title = ?2 WHERE id = ?1",
            params![id, title],
        )?;
        Ok(())
    }

    /// Visits newest first, after the visit `before` (its time and id) when given, whose
    /// address or title holds `query`. The id breaks ties, so a page boundary between visits at
    /// the same millisecond skips none of them.
    pub fn history(
        &self,
        query: &str,
        filter: HistoryFilter,
        before: Option<(i64, i64)>,
        limit: u32,
    ) -> rusqlite::Result<Vec<BrowserVisit>> {
        let agent = match filter {
            HistoryFilter::All => None,
            HistoryFilter::Agent => Some(true),
            HistoryFilter::Other => Some(false),
        };
        let mut statement = self.db.prepare_cached(
            "SELECT id, url, title, at_ms, agent FROM visits
             WHERE (url LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\')
               AND (?2 IS NULL OR agent = ?2)
               AND (?3 IS NULL OR at_ms < ?3 OR (at_ms = ?3 AND id < ?5))
             ORDER BY at_ms DESC, id DESC LIMIT ?4",
        )?;
        statement
            .query_map(
                params![
                    like(query),
                    agent,
                    before.map(|(at_ms, _)| at_ms),
                    limit.min(PAGE_LIMIT),
                    before.map(|(_, id)| id),
                ],
                |row| {
                    Ok(BrowserVisit {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        title: row.get(2)?,
                        at_ms: row.get(3)?,
                        agent: row.get(4)?,
                    })
                },
            )?
            .collect()
    }

    pub fn remove_visits(&self, ids: &[i64]) -> rusqlite::Result<()> {
        let mut statement = self.db.prepare_cached("DELETE FROM visits WHERE id = ?1")?;
        for id in ids {
            statement.execute([id])?;
        }
        Ok(())
    }

    /// Adds pages another browser showed, as the user's own; ones already here at the same time
    /// are skipped. Returns how many were added.
    pub fn import_visits<'a>(
        &mut self,
        visits: impl IntoIterator<Item = (&'a str, &'a str, i64)>,
    ) -> rusqlite::Result<usize> {
        let transaction = self.db.transaction()?;
        let mut added = 0;
        {
            let mut known =
                transaction.prepare_cached("SELECT 1 FROM visits WHERE url = ?1 AND at_ms = ?2")?;
            let mut insert = transaction.prepare_cached(
                "INSERT INTO visits (url, title, at_ms, agent) VALUES (?1, ?2, ?3, 0)",
            )?;
            for (url, title, at_ms) in visits {
                if !known.exists(params![url, at_ms])? {
                    insert.execute(params![url, title, at_ms])?;
                    added += 1;
                }
            }
        }
        transaction.commit()?;
        Ok(added)
    }

    pub fn clear_history(
        &self,
        since_ms: Option<i64>,
        until_ms: Option<i64>,
    ) -> rusqlite::Result<()> {
        self.db.execute(
            "DELETE FROM visits WHERE (?1 IS NULL OR at_ms >= ?1) AND (?2 IS NULL OR at_ms <= ?2)",
            params![since_ms, until_ms],
        )?;
        Ok(())
    }
}
