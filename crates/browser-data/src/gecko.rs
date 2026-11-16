//! Gecko-family browsers: Firefox and its forks (Zen, LibreWolf, Waterfox, Floorp).
//!
//! Profiles are listed in `profiles.ini` at the browser's root. Cookies live in
//! `cookies.sqlite` (`moz_cookies`, unencrypted); history and bookmarks in `places.sqlite`.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::sqlite::{columns, open_copy};
use crate::{
    Bookmark, BookmarkRoot, Bookmarks, Cookie, Cookies, Error, SameSite, Visit, is_web_url,
};

mod discovery;
pub(crate) use discovery::{discover, discover_other};

/// Firefox's cookie schema version whose migration multiplied `expiry` by 1000, turning it
/// from seconds into milliseconds.
///
/// Recalled from Firefox's netwerk/cookie/CookiePersistentStorage.cpp (the 15 → 16 migration,
/// shipped around Firefox 141), not verified against the source here, so treat it as likely
/// rather than certain. [`expiry_secs`] therefore decides by magnitude first and uses this
/// only for the narrow range where magnitude can't tell.
const EXPIRY_MS_SCHEMA: i64 = 16;
/// Any expiry at or above this is milliseconds: as seconds it would be past the year 33000,
/// and as milliseconds it is after 2001.
const SURELY_MS: i64 = 1_000_000_000_000;
/// Any expiry below this is seconds: as milliseconds it would be before 1973.
const SURELY_SECS: i64 = 100_000_000_000;

/// A `moz_cookies.expiry` in Unix seconds. Magnitude decides wherever it can (see
/// [`SURELY_MS`] and [`SURELY_SECS`]); the schema version only settles values in between.
pub(crate) fn expiry_secs(raw: i64, schema: i64) -> i64 {
    let millis = raw >= SURELY_MS || (raw >= SURELY_SECS && schema >= EXPIRY_MS_SCHEMA);
    if millis { raw.div_euclid(1000) } else { raw }
}

pub(crate) fn read_cookies(dir: &Path, now_unix: i64) -> Result<Cookies, Error> {
    let conn = open_copy(&dir.join("cookies.sqlite"))?;
    let cols = columns(&conn, "moz_cookies")?;
    if !cols.contains("host") || !cols.contains("name") {
        return Err(Error::Format("no Firefox cookies table".to_owned()));
    }
    let pick = |name: &str, fallback: &str| -> String {
        if cols.contains(name) {
            name.to_owned()
        } else {
            fallback.to_owned()
        }
    };
    let sql = format!(
        "SELECT name, {value}, host, {path}, {expiry}, {secure}, {http_only}, {same_site},
                {origin}, {partitioned} FROM moz_cookies",
        value = pick("value", "''"),
        path = pick("path", "'/'"),
        expiry = pick("expiry", "0"),
        secure = pick("isSecure", "0"),
        http_only = pick("isHttpOnly", "0"),
        same_site = pick("sameSite", "-1"),
        origin = pick("originAttributes", "''"),
        partitioned = pick("isPartitionedAttributeSet", "0"),
    );
    let schema: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    let mut out = Cookies::default();
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let expires = expiry_secs(row.get::<_, Option<i64>>(4)?.unwrap_or(0), schema);
        if expires < now_unix {
            out.expired += 1;
            continue;
        }
        // Containers, private windows and partitioned (CHIPS) cookies carry origin attributes;
        // WebKit's store has no place to keep that isolation.
        let origin: Option<String> = row.get(8)?;
        let partitioned_attr = row.get::<_, Option<i64>>(9)?.unwrap_or(0) != 0;
        if partitioned_attr || origin.is_some_and(|origin| !origin.is_empty()) {
            out.partitioned += 1;
            if let Ok(Some(host)) = row.get::<_, Option<String>>(2) {
                out.partitioned_domains.push(host);
            }
            continue;
        }
        let (Ok(Some(name)), Ok(Some(value)), Ok(Some(host))) = (
            row.get::<_, Option<String>>(0),
            row.get::<_, Option<String>>(1),
            row.get::<_, Option<String>>(2),
        ) else {
            out.unreadable += 1;
            continue;
        };
        let same_site = match row.get::<_, Option<i64>>(7)?.unwrap_or(-1) {
            0 => Some(SameSite::None),
            1 => Some(SameSite::Lax),
            2 => Some(SameSite::Strict),
            _ => None,
        };
        out.cookies.push(Cookie {
            name,
            value,
            host_only: !host.starts_with('.'),
            domain: host,
            path: row
                .get::<_, Option<String>>(3)?
                .unwrap_or_else(|| "/".to_owned()),
            // Firefox writes only persistent cookies to disk, so every one has an expiry.
            expires_unix: Some(expires),
            secure: row.get::<_, Option<i64>>(5)?.unwrap_or(0) != 0,
            http_only: row.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
            same_site,
            source_insecure: false,
        });
    }
    Ok(out)
}

/// How many cookies a profile's store holds outside containers, private windows and
/// partitions, the ones an import can bring.
pub(crate) fn count_cookies(dir: &Path) -> Result<usize, Error> {
    let conn = open_copy(&dir.join("cookies.sqlite"))?;
    let cols = columns(&conn, "moz_cookies")?;
    let mut sql = "SELECT COUNT(*) FROM moz_cookies WHERE 1".to_owned();
    if cols.contains("originAttributes") {
        sql.push_str(" AND originAttributes = ''");
    }
    if cols.contains("isPartitionedAttributeSet") {
        sql.push_str(" AND isPartitionedAttributeSet = 0");
    }
    let count: i64 = conn.query_row(&sql, [], |row| row.get(0))?;
    Ok(usize::try_from(count).unwrap_or(0))
}

pub(crate) fn read_history(dir: &Path, limit: usize) -> Result<Vec<Visit>, Error> {
    let conn = open_copy(&dir.join("places.sqlite"))?;
    let mut stmt = conn.prepare(
        "SELECT p.url, COALESCE(p.title, ''), v.visit_date
         FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
         WHERE p.url LIKE 'http://%' OR p.url LIKE 'https://%'
         GROUP BY p.url, v.visit_date
         ORDER BY v.visit_date DESC, p.url
         LIMIT ?1",
    )?;
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let rows = stmt.query_map([limit], |row| {
        // PRTime: microseconds since the Unix epoch.
        let micros: i64 = row.get(2)?;
        Ok(Visit {
            url: row.get(0)?,
            title: row.get(1)?,
            visited_at_ms: micros.div_euclid(1000),
        })
    })?;
    let mut visits = Vec::new();
    for visit in rows {
        let visit = visit?;
        if is_web_url(&visit.url) {
            visits.push(visit);
        }
    }
    Ok(visits)
}

/// A `moz_bookmarks` row.
struct BookmarkRow {
    id: i64,
    kind: i64,
    title: String,
    url: Option<String>,
    added_micros: Option<i64>,
}

/// The `moz_bookmarks` type of a bookmark, and of a folder. Separators are the third.
const TYPE_BOOKMARK: i64 = 1;
const TYPE_FOLDER: i64 = 2;
/// The guids of the folders holding what the user sees. The tags folder is left out on purpose:
/// its rows are labels on bookmarks that are listed elsewhere.
const BOOKMARK_ROOTS: [(&str, BookmarkRoot); 4] = [
    ("toolbar_____", BookmarkRoot::Bar),
    ("menu________", BookmarkRoot::Menu),
    ("unfiled_____", BookmarkRoot::Other),
    ("mobile______", BookmarkRoot::Mobile),
];

pub(crate) fn read_bookmarks(dir: &Path) -> Result<Bookmarks, Error> {
    let conn = open_copy(&dir.join("places.sqlite"))?;
    let mut children: HashMap<i64, Vec<BookmarkRow>> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT b.id, b.parent, b.type, COALESCE(NULLIF(b.title, ''), p.title, ''), p.url,
                b.dateAdded
         FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk
         ORDER BY b.parent, b.position, b.id",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        children.entry(row.get(1)?).or_default().push(BookmarkRow {
            id: row.get(0)?,
            kind: row.get(2)?,
            title: row.get(3)?,
            url: row.get(4)?,
            added_micros: row.get(5)?,
        });
    }
    let mut out = Bookmarks::default();
    for (guid, root) in BOOKMARK_ROOTS {
        let id: Option<i64> = conn
            .query_row(
                "SELECT id FROM moz_bookmarks WHERE guid = ?1",
                [guid],
                |row| row.get(0),
            )
            .ok();
        if let Some(id) = id {
            let mut seen = HashSet::from([id]);
            walk_bookmarks(id, &children, root, &mut Vec::new(), &mut seen, &mut out);
        }
    }
    Ok(out)
}

/// Collects the bookmarks under a folder. `seen` stops a damaged database from looping.
fn walk_bookmarks(
    parent: i64,
    children: &HashMap<i64, Vec<BookmarkRow>>,
    root: BookmarkRoot,
    folders: &mut Vec<String>,
    seen: &mut HashSet<i64>,
    out: &mut Bookmarks,
) {
    for row in children.get(&parent).into_iter().flatten() {
        match row.kind {
            TYPE_FOLDER if seen.insert(row.id) => {
                folders.push(row.title.clone());
                walk_bookmarks(row.id, children, root, folders, seen, out);
                folders.pop();
            }
            TYPE_BOOKMARK => match row.url.as_deref().filter(|url| is_web_url(url)) {
                Some(url) => out.bookmarks.push(Bookmark {
                    url: url.to_owned(),
                    title: row.title.clone(),
                    root,
                    folders: folders.clone(),
                    // PRTime: microseconds since the Unix epoch.
                    added_at_ms: row
                        .added_micros
                        .filter(|micros| *micros > 0)
                        .map(|micros| micros.div_euclid(1000)),
                }),
                None => out.skipped += 1,
            },
            _ => {}
        }
    }
}
