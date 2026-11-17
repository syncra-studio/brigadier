//! Full-text search over sessions' archived text [D72].

use super::db_err;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// At most this many sessions come back from a search.
const HITS: usize = 50;
/// Where a match starts and ends in a snippet, marked by `snippet()` and taken out again.
pub(crate) const OPEN: char = '\u{2}';
pub(crate) const CLOSE: char = '\u{3}';

/// Sessions whose text holds every word, each as a whole word or a word start [D72]: archived ones last, then the
/// best match first [D197]. Each comes with its best message's snippet on one line, and where the words are in it
/// as UTF-16 offsets, the way the UI counts [D196]. Its own read-only connection and a single statement, so no
/// read transaction stays open.
pub fn search(data: &Path, q: &str) -> io::Result<Vec<Value>> {
    let terms = words(q);
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let db = Connection::open_with_flags(data.join("index.db"), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(db_err)?;
    // Each word may sit in a different message of the same session; the snippet comes from the message
    // holding the most of them.
    let one = "SELECT id FROM text WHERE text MATCH ? AND src IN ('user', 'agent')";
    let every = vec![one; terms.len()].join(" INTERSECT ");
    let sql = format!(
        "SELECT text.id, snippet(text, 4, char(2), char(3), '…', 12) FROM text JOIN sessions ON sessions.id = text.id
         WHERE text MATCH ? AND text.src IN ('user', 'agent') AND text.id IN ({every}) ORDER BY sessions.archived, text.rank"
    );
    let any = format!("body : ({})", terms.join(" OR "));
    let terms: Vec<String> = terms.iter().map(|t| format!("body : {t}")).collect();
    let params = std::iter::once(&any).chain(&terms);
    let mut stmt = db.prepare(&sql).map_err(db_err)?;
    let mut rows = stmt
        .query(rusqlite::params_from_iter(params))
        .map_err(db_err)?;
    let (mut hits, mut seen) = (vec![], std::collections::HashSet::new());
    // shortcut: ranks every message holding any of the words before the first comes back; fine for the
    // words people type, a per-session rank table if a common one ever profiles slow.
    while hits.len() < HITS
        && let Some(row) = rows.next().map_err(db_err)?
    {
        let id: String = row.get(0).map_err(db_err)?;
        if seen.insert(id.clone()) {
            hits.push(hit(id, &row.get::<_, String>(1).map_err(db_err)?));
        }
    }
    Ok(hits)
}

/// Each word as a whole word or a word start, quoted for FTS5.
pub(crate) fn words(q: &str) -> Vec<String> {
    q.split_whitespace()
        .map(|w| format!("\"{}\"*", w.replace('"', "\"\"")))
        .collect()
}

/// A snippet on one line with its marks taken out, and where they were.
fn hit(id: String, marked: &str) -> Value {
    let (mut snippet, mut at, mut from, mut len) = (String::new(), vec![], 0, 0);
    for word in marked.split_whitespace() {
        if !snippet.is_empty() {
            snippet.push(' ');
            len += 1;
        }
        for c in word.chars() {
            match c {
                OPEN => from = len,
                CLOSE => at.push([from, len]),
                c => {
                    snippet.push(c);
                    len += c.len_utf16();
                }
            }
        }
    }
    json!({"id": id, "snippet": snippet, "at": at})
}
