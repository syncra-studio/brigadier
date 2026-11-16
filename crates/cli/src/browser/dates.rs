//! When each cookie last changed and each site last had a frame: Chromium dates neither, and Clear browsing data
//! clears both by time range (the old app's browserClearData). Main sends what it saw, a second's worth at a time.

use super::store::Store;
use serde::Deserialize;
use serde_json::{Value, json};
use std::io;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cookie {
    domain: String,
    path: String,
    name: String,
    /// None: the cookie went.
    last_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Site {
    origin: String,
    last_ms: i64,
}

#[derive(Deserialize)]
struct Seen {
    cookies: Vec<Cookie>,
    sites: Vec<Site>,
}

pub(super) fn run(store: &Store, args: &[String]) -> io::Result<Value> {
    let sql = io::Error::other;
    let db = &store.db;
    match crate::arg(args, 0)? {
        "record" => {
            let seen: Seen = serde_json::from_str(crate::arg(args, 1)?)?;
            for site in &seen.sites {
                super::web_address(&site.origin)?;
            }
            let transaction = db.unchecked_transaction().map_err(sql)?;
            for c in seen.cookies {
                match c.last_ms {
                    Some(ms) => transaction.execute(
                        "INSERT INTO cookie_changes (domain, path, name, last_ms) VALUES (?1, ?2, ?3, ?4)
                         ON CONFLICT (domain, path, name) DO UPDATE SET last_ms = excluded.last_ms",
                        rusqlite::params![c.domain, c.path, c.name, ms],
                    ),
                    None => transaction.execute(
                        "DELETE FROM cookie_changes WHERE domain = ?1 AND path = ?2 AND name = ?3",
                        rusqlite::params![c.domain, c.path, c.name],
                    ),
                }
                .map_err(sql)?;
            }
            for site in seen.sites {
                transaction
                    .execute(
                        "INSERT INTO site_activity (origin, last_ms) VALUES (?1, ?2)
                         ON CONFLICT (origin) DO UPDATE SET last_ms = MAX(last_ms, excluded.last_ms)",
                        rusqlite::params![site.origin, site.last_ms],
                    )
                    .map_err(sql)?;
            }
            transaction.commit().map_err(sql)?;
        }
        "since" => {
            let since: i64 = crate::arg(args, 1)?.parse().map_err(io::Error::other)?;
            let mut cookies = db
                .prepare("SELECT domain, path, name FROM cookie_changes WHERE last_ms >= ?1")
                .map_err(sql)?;
            let cookies = cookies
                .query_map([since], |row| {
                    Ok(json!({"domain": row.get::<_, String>(0)?, "path": row.get::<_, String>(1)?, "name": row.get::<_, String>(2)?}))
                })
                .and_then(Iterator::collect::<Result<Vec<_>, _>>)
                .map_err(sql)?;
            let mut origins = db
                .prepare("SELECT origin FROM site_activity WHERE last_ms >= ?1")
                .map_err(sql)?;
            let origins = origins
                .query_map([since], |row| row.get::<_, String>(0))
                .and_then(Iterator::collect::<Result<Vec<_>, _>>)
                .map_err(sql)?;
            return Ok(json!({"ok": true, "cookies": cookies, "origins": origins}));
        }
        "clear" => db
            .execute_batch("DELETE FROM cookie_changes; DELETE FROM site_activity;")
            .map_err(sql)?,
        _ => {
            return Err(io::Error::other(
                "usage: dates record JSON | since MS | clear",
            ));
        }
    }
    Ok(json!({"ok": true}))
}
