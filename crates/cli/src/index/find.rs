//! Agents' search over the archive's entries [D103].

use super::db_err;
use super::search::{CLOSE, OPEN, words};
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// At most this many entries come back from an agent's search.
const FOUND: usize = 30;

/// The archive entries holding every word, all in the same entry, newest first [D103]: from one
/// session (`within`), one sender (`from`), and touching a file (`file`, a path's words in order),
/// as any of these asks. Each as `{id, at, from, ts, snippet}`.
pub fn find(
    data: &Path,
    q: &str,
    within: Option<&str>,
    from: Option<&str>,
    file: Option<&str>,
) -> io::Result<Vec<Value>> {
    let mut parts = vec![];
    if !q.trim().is_empty() {
        parts.push(format!("body : ({})", words(q).join(" ")));
    }
    if let Some(file) = file {
        parts.push(format!("files : \"{}\"", file.replace('"', "\"\"")));
    }
    if parts.is_empty() {
        return Ok(vec![]);
    }
    let db = Connection::open_with_flags(data.join("index.db"), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(db_err)?;
    let sql = "SELECT id, at, src, ts, snippet(text, 4, char(2), char(3), '…', 16), files FROM text
               WHERE text MATCH ?1 AND (?2 IS NULL OR id = ?2) AND (?3 IS NULL OR src = ?3)
               ORDER BY ts DESC LIMIT ?4";
    let mut stmt = db.prepare(sql).map_err(db_err)?;
    let rows = stmt
        .query_map(
            params![parts.join(" AND "), within, from, FOUND as i64],
            |r| {
                let marked: String = r.get(4)?;
                let snippet: String = marked.chars().filter(|c| ![OPEN, CLOSE].contains(c)).collect();
                Ok(json!({"id": r.get::<_, String>(0)?, "at": r.get::<_, String>(1)?, "from": r.get::<_, String>(2)?,
                    "ts": r.get::<_, i64>(3)?, "snippet": snippet.split_whitespace().collect::<Vec<_>>().join(" "),
                    "files": r.get::<_, String>(5)?}))
            },
        )
        .map_err(db_err)?;
    rows.collect::<Result<_, _>>().map_err(db_err)
}
