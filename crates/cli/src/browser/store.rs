//! The old browser store, with versioned SQLite migrations, one file per profile.

use super::types::*;
use rusqlite::Connection;
use std::io;
use std::path::Path;

/// The schema, by `PRAGMA user_version`.
const SCHEMA: &[&str] = &[
    r"
    CREATE TABLE visits (
        id INTEGER PRIMARY KEY,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        at_ms INTEGER NOT NULL,
        agent INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX visits_at ON visits (at_ms);
    CREATE TABLE downloads (
        id INTEGER PRIMARY KEY,
        url TEXT NOT NULL,
        path TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        state TEXT NOT NULL
    );
    CREATE TABLE sites (
        origin TEXT PRIMARY KEY,
        camera TEXT NOT NULL DEFAULT 'ask',
        microphone TEXT NOT NULL DEFAULT 'ask',
        asked_ms INTEGER NOT NULL
    );
",
    r"
    CREATE TABLE imports (
        browser TEXT PRIMARY KEY,
        record TEXT,
        keychain_denied INTEGER NOT NULL DEFAULT 0
    );
",
    "ALTER TABLE sites ADD COLUMN location TEXT NOT NULL DEFAULT 'ask';",
    r"
    CREATE TABLE site_activity (origin TEXT PRIMARY KEY, last_ms INTEGER NOT NULL);
    CREATE TABLE cookie_changes (
        domain TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        last_ms INTEGER NOT NULL,
        PRIMARY KEY (domain, path, name)
    );
",
];

/// The most downloads a list returns at once.
pub(super) const PAGE_LIMIT: u32 = 500;

pub struct Store {
    pub(super) db: Connection,
}

/// The camera or the microphone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device {
    Camera,
    Microphone,
    Location,
}

impl Device {
    pub(super) fn column(self) -> &'static str {
        match self {
            Device::Camera => "camera",
            Device::Microphone => "microphone",
            Device::Location => "location",
        }
    }
}

pub(super) fn permission_text(permission: SitePermission) -> &'static str {
    match permission {
        SitePermission::Ask => "ask",
        SitePermission::Allow => "allow",
        SitePermission::Block => "block",
    }
}

pub(super) fn permission(text: &str) -> SitePermission {
    match text {
        "allow" => SitePermission::Allow,
        "block" => SitePermission::Block,
        _ => SitePermission::Ask,
    }
}

pub(super) fn state_text(state: DownloadState) -> &'static str {
    match state {
        DownloadState::Running => "running",
        DownloadState::Done => "done",
        DownloadState::Failed => "failed",
        DownloadState::Cancelled => "cancelled",
    }
}

pub(super) fn state(text: &str) -> DownloadState {
    match text {
        "done" => DownloadState::Done,
        "running" => DownloadState::Running,
        "cancelled" => DownloadState::Cancelled,
        _ => DownloadState::Failed,
    }
}

/// `query` as a LIKE pattern matching it anywhere, its own `%`, `_` and `\` taken literally.
pub(super) fn like(query: &str) -> String {
    let mut pattern = String::from("%");
    for c in query.trim().chars() {
        if matches!(c, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    pattern
}

impl Store {
    pub fn open(path: &Path) -> io::Result<Self> {
        let db = Connection::open(path).map_err(io::Error::other)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(io::Error::other)?;
        db.pragma_update(None, "journal_mode", "WAL")
            .map_err(io::Error::other)?;
        let version: i64 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(io::Error::other)?;
        if version < 0 || version as usize > SCHEMA.len() {
            return Err(io::Error::other(format!(
                "Unsupported browser data schema version {version}"
            )));
        }
        let transaction = db.unchecked_transaction().map_err(io::Error::other)?;
        for (at, step) in (0_i64..).zip(SCHEMA).skip(version as usize) {
            transaction.execute_batch(step).map_err(io::Error::other)?;
            transaction
                .pragma_update(None, "user_version", at + 1)
                .map_err(io::Error::other)?;
        }
        transaction.commit().map_err(io::Error::other)?;
        Ok(Self { db })
    }
}
