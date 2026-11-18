//! Downloads and import receipts from the old browser store.

use super::store::{PAGE_LIMIT, Store, like, state, state_text};
use super::types::*;
use rusqlite::{OptionalExtension, params};

impl Store {
    pub fn interrupt_downloads(&self) -> rusqlite::Result<()> {
        self.db.execute(
            "UPDATE downloads SET state = 'failed' WHERE state = 'running'",
            [],
        )?;
        Ok(())
    }

    pub fn download_started(&self, url: &str, path: &str, at_ms: i64) -> rusqlite::Result<i64> {
        self.db.execute(
            "INSERT INTO downloads (url, path, at_ms, state) VALUES (?1, ?2, ?3, ?4)",
            params![url, path, at_ms, state_text(DownloadState::Running)],
        )?;
        Ok(self.db.last_insert_rowid())
    }

    pub fn download_finished(&self, id: i64, state: DownloadState) -> rusqlite::Result<()> {
        self.db.execute(
            "UPDATE downloads SET state = ?2 WHERE id = ?1",
            params![id, state_text(state)],
        )?;
        Ok(())
    }

    /// Downloads newest first, whose address or file holds `query`.
    pub fn downloads(&self, query: &str) -> rusqlite::Result<Vec<BrowserDownload>> {
        let mut statement = self.db.prepare_cached(
            "SELECT id, url, path, at_ms, state FROM downloads
             WHERE url LIKE ?1 ESCAPE '\\' OR path LIKE ?1 ESCAPE '\\'
             ORDER BY at_ms DESC, id DESC LIMIT ?2",
        )?;
        statement
            .query_map(params![like(query), PAGE_LIMIT], |row| {
                Ok(BrowserDownload {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    path: row.get(2)?,
                    at_ms: row.get(3)?,
                    state: state(&row.get::<_, String>(4)?),
                })
            })?
            .collect()
    }

    /// Where finished download `id` was saved; none while it runs, after it failed, or once
    /// it is forgotten.
    pub fn finished_download(&self, id: i64) -> rusqlite::Result<Option<String>> {
        self.db
            .query_row(
                "SELECT path FROM downloads WHERE id = ?1 AND state = ?2",
                params![id, state_text(DownloadState::Done)],
                |row| row.get(0),
            )
            .optional()
    }

    /// Forgets downloads (the files stay): `ids`, or with none every finished one since
    /// `since_ms`.
    pub fn remove_downloads(
        &self,
        ids: Option<&[i64]>,
        since_ms: Option<i64>,
        until_ms: Option<i64>,
    ) -> rusqlite::Result<()> {
        match ids {
            Some(ids) => {
                let mut statement = self
                    .db
                    .prepare_cached("DELETE FROM downloads WHERE id = ?1")?;
                for id in ids {
                    statement.execute([id])?;
                }
            }
            None => {
                self.db.execute(
                    "DELETE FROM downloads WHERE state != 'running' AND (?1 IS NULL OR at_ms >= ?1) AND (?2 IS NULL OR at_ms <= ?2)",
                    params![since_ms, until_ms],
                )?;
            }
        }
        Ok(())
    }
}
