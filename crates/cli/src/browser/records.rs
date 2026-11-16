//! Downloads, site choices and import receipts from the old browser store.

use super::store::{
    Device, PAGE_LIMIT, Store, like, permission, permission_text, state, state_text,
};
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

    /// The site `origin` asked for `device`: it is listed from now on. Returns the choice.
    pub fn site_asked(
        &self,
        origin: &str,
        device: Device,
        at_ms: i64,
    ) -> rusqlite::Result<SitePermission> {
        self.db.execute(
            "INSERT INTO sites (origin, asked_ms) VALUES (?1, ?2)
             ON CONFLICT (origin) DO UPDATE SET asked_ms = excluded.asked_ms",
            params![origin, at_ms],
        )?;
        let text: String = self.db.query_row(
            &format!("SELECT {} FROM sites WHERE origin = ?1", device.column()),
            [origin],
            |row| row.get(0),
        )?;
        Ok(permission(&text))
    }

    pub fn sites(&self) -> rusqlite::Result<Vec<BrowserSite>> {
        let mut statement = self.db.prepare_cached(
            "SELECT origin, camera, microphone, asked_ms, location FROM sites ORDER BY origin",
        )?;
        statement
            .query_map([], |row| {
                Ok(BrowserSite {
                    origin: row.get(0)?,
                    camera: permission(&row.get::<_, String>(1)?),
                    microphone: permission(&row.get::<_, String>(2)?),
                    location: permission(&row.get::<_, String>(4)?),
                    asked_ms: row.get(3)?,
                })
            })?
            .collect()
    }

    pub fn set_site(
        &self,
        origin: &str,
        device: Device,
        choice: SitePermission,
        at_ms: i64,
    ) -> rusqlite::Result<()> {
        self.db.execute(
            "INSERT INTO sites (origin, asked_ms) VALUES (?1, ?2) ON CONFLICT(origin) DO NOTHING",
            params![origin, at_ms],
        )?;
        self.db.execute(
            &format!(
                "UPDATE sites SET {} = ?2 WHERE origin = ?1",
                device.column()
            ),
            params![origin, permission_text(choice)],
        )?;
        Ok(())
    }

    /// Forgets sites in the time range, and their choices.
    pub fn clear_sites(
        &self,
        since_ms: Option<i64>,
        until_ms: Option<i64>,
    ) -> rusqlite::Result<()> {
        self.db.execute(
            "DELETE FROM sites WHERE (?1 IS NULL OR asked_ms >= ?1) AND (?2 IS NULL OR asked_ms <= ?2)",
            params![since_ms, until_ms],
        )?;
        Ok(())
    }
}
