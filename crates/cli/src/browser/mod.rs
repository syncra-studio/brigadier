//! The app's browser data commands. Agent actions use separate verbs [D515, D516, D519].

mod bookmarks;
mod dates;
mod history;
mod hub;
pub(crate) mod profiles;
mod records;
mod store;
mod types;
mod vault;

use brigadier_core as core;
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::{fs, io};
use store::{Device, Store};
use types::{DownloadState, HistoryFilter, ImportRecord, ImportedVisit, SitePermission};

pub(crate) use hub::{HELP, answered};
pub use hub::{agent, leave, page};

const USAGE: &str = "usage: brigadier browser <session|-> profiles list|create|rename|recolour|move|make-default|delete-mark|forget|session-pick|tab-pick|resolve ... [--json]\n       brigadier browser <session|-> history list|search|remove|clear | visit record|title | downloads list|start|finish|finished|remove|clear|interrupt | sites list|asked|set|clear | imports list|save|denied|visits | bookmarks list|add|update|remove|import | dates record|since|clear | vault list|reveal|fill|never|add|used|remove|never-add|allow|import|replace ... [--profile ID] [--json]";

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    // The agents' side: the page's answer to a call, and the user's takeover and Continue (hub.rs).
    if args.get(1).is_some_and(|a| a == "answer") || args.get(2).is_some_and(|a| a == "paused") {
        return hub::run(args);
    }
    for flag in [
        "--profile",
        "--tab",
        "--hue",
        "--at-ms",
        "--since-ms",
        "--until-ms",
        "--before-ms",
        "--before-id",
        "--limit",
        "--query",
        "--filter",
        "--last",
    ] {
        if args
            .iter()
            .enumerate()
            .any(|(i, a)| a == flag && args.get(i + 1).is_none_or(|v| v.starts_with("--")))
        {
            return Err(io::Error::other(format!("Expected a value for {flag}")));
        }
    }
    let session = crate::arg(args, 1)?;
    if session != "-" && session != crate::HOME_DRAFT {
        core::check_id(session)?;
    }
    let area = crate::arg(args, 2)?;
    if ![
        "profiles",
        "history",
        "visit",
        "downloads",
        "sites",
        "imports",
        "bookmarks",
        "dates",
        "vault",
    ]
    .contains(&area)
    {
        return Err(io::Error::other(USAGE));
    }
    let root = data.join("browser");
    let _one = core::projects::lock(&root, "profiles.lock")?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    let mut places = profiles::Places::read(data)?;
    if area == "profiles" {
        return places.run(data, session, &args[3..]);
    }
    let profile = match crate::flag(args, "--profile") {
        Some(id) => {
            places.known(id)?;
            id.to_string()
        }
        None => places.resolve(data, session, crate::flag(args, "--tab"))?,
    };
    places.known(&profile)?;
    let folder = root.join(&profile);
    fs::create_dir_all(&folder)?;
    let args = &args[3..];
    if area == "bookmarks" {
        return bookmarks::run(&folder, args);
    }
    if area == "vault" {
        return vault::run(data, &folder, args);
    }
    let mut store = Store::open(&folder.join("browser.sqlite"))?;
    if area == "dates" {
        return dates::run(&store, args);
    }
    stored(&mut store, area, args)
}

fn stored(store: &mut Store, area: &str, args: &[String]) -> io::Result<Value> {
    let get = |i| crate::arg(args, i);
    let op = get(0)?;
    let number = |i| -> io::Result<i64> { get(i)?.parse().map_err(io::Error::other) };
    let at = optional_number(args, "--at-ms")?.unwrap_or_else(now);
    let since = optional_number(args, "--since-ms")?;
    let until = optional_number(args, "--until-ms")?;
    if since.zip(until).is_some_and(|(a, b)| a > b) {
        return Err(io::Error::other("Invalid time range"));
    }
    let done = || Ok(json!({"ok": true}));
    let sql = |e| io::Error::other(e);
    match (area, op) {
        ("history", "list" | "search") => {
            let filter = match crate::flag(args, "--filter").unwrap_or("all") {
                "all" => HistoryFilter::All,
                "agent" => HistoryFilter::Agent,
                "other" => HistoryFilter::Other,
                _ => return Err(io::Error::other("Unknown history filter")),
            };
            let before = optional_number(args, "--before-ms")?
                .map(|ms| {
                    Ok::<_, io::Error>((
                        ms,
                        optional_number(args, "--before-id")?.unwrap_or(i64::MAX),
                    ))
                })
                .transpose()?;
            let limit: u32 = crate::flag(args, "--limit")
                .unwrap_or("500")
                .parse()
                .map_err(io::Error::other)?;
            let query = if op == "search" {
                get(1)?
            } else {
                crate::flag(args, "--query").unwrap_or("")
            };
            Ok(
                json!({"ok": true, "history": store.history(query, filter, before, limit).map_err(sql)?}),
            )
        }
        ("history", "remove") => {
            store.remove_visits(&ids(args)?).map_err(sql)?;
            done()
        }
        ("history", "clear") => {
            store.clear_history(since, until).map_err(sql)?;
            done()
        }
        ("visit", "record") => {
            web_address(get(1)?)?;
            let title = args
                .get(2)
                .filter(|s| !s.starts_with("--"))
                .map_or("", String::as_str);
            let id = store
                .visit(
                    optional_number(args, "--last")?,
                    get(1)?,
                    title,
                    crate::has(args, "--agent"),
                    at,
                )
                .map_err(sql)?;
            Ok(json!({"ok": true, "id": id}))
        }
        ("visit", "title") => {
            store.titled(number(1)?, get(2)?).map_err(sql)?;
            done()
        }
        ("downloads", "list") => Ok(
            json!({"ok": true, "downloads": store.downloads(crate::flag(args, "--query").unwrap_or("")).map_err(sql)?}),
        ),
        ("downloads", "start") => {
            web_address(get(1)?)?;
            let id = store.download_started(get(1)?, get(2)?, at).map_err(sql)?;
            Ok(json!({"ok": true, "id": id}))
        }
        ("downloads", "finish") => {
            let finished = match get(2)? {
                "done" => DownloadState::Done,
                "failed" => DownloadState::Failed,
                "cancelled" => DownloadState::Cancelled,
                _ => return Err(io::Error::other("Expected done, failed or cancelled")),
            };
            store.download_finished(number(1)?, finished).map_err(sql)?;
            done()
        }
        ("downloads", "finished") => {
            Ok(json!({"ok": true, "path": store.finished_download(number(1)?).map_err(sql)?}))
        }
        ("downloads", "remove") => {
            store
                .remove_downloads(Some(&ids(args)?), None, None)
                .map_err(sql)?;
            done()
        }
        ("downloads", "clear") => {
            store.remove_downloads(None, since, until).map_err(sql)?;
            done()
        }
        // Connections are per command: only the shell's startup call interrupts old downloads.
        ("downloads", "interrupt") => {
            store.interrupt_downloads().map_err(sql)?;
            done()
        }
        ("sites", "list") => Ok(json!({"ok": true, "sites": store.sites().map_err(sql)?})),
        ("sites", "asked") => {
            web_address(get(1)?)?;
            let choice = store
                .site_asked(get(1)?, device(get(2)?)?, at)
                .map_err(sql)?;
            Ok(json!({"ok": true, "choice": choice}))
        }
        ("sites", "set") => {
            web_address(get(1)?)?;
            let device = device(get(2)?)?;
            let choice = match get(3)? {
                "ask" => SitePermission::Ask,
                "allow" => SitePermission::Allow,
                "block" => SitePermission::Block,
                _ => return Err(io::Error::other("Expected ask, allow or block")),
            };
            store.set_site(get(1)?, device, choice, at).map_err(sql)?;
            done()
        }
        ("sites", "clear") => {
            store.clear_sites(since, until).map_err(sql)?;
            done()
        }
        ("imports", "list") => Ok(json!({"ok": true, "imports": store.imports().map_err(sql)?})),
        ("imports", "save") => {
            let record: ImportRecord = serde_json::from_str(get(2)?)?;
            store.save_import(get(1)?, &record).map_err(sql)?;
            done()
        }
        ("imports", "denied") => {
            store.import_denied(get(1)?).map_err(sql)?;
            done()
        }
        ("imports", "visits") => {
            let visits: Vec<ImportedVisit> = serde_json::from_str(get(1)?)?;
            let added = store
                .import_visits(
                    visits
                        .iter()
                        .filter(|v| web_address(&v.url).is_ok())
                        .map(|v| (v.url.as_str(), v.title.as_str(), v.at_ms)),
                )
                .map_err(sql)?;
            Ok(json!({"ok": true, "added": added}))
        }
        _ => Err(io::Error::other(USAGE)),
    }
}

fn ids(args: &[String]) -> io::Result<Vec<i64>> {
    let values: Vec<_> = args[1..]
        .iter()
        .take_while(|s| !s.starts_with("--"))
        .collect();
    if values.is_empty() {
        return Err(io::Error::other("Expected record ids"));
    }
    values
        .into_iter()
        .map(|s| s.parse().map_err(io::Error::other))
        .collect()
}

fn optional_number(args: &[String], flag: &str) -> io::Result<Option<i64>> {
    crate::flag(args, flag)
        .map(|s| s.parse().map_err(io::Error::other))
        .transpose()
}

fn device(value: &str) -> io::Result<Device> {
    match value {
        "camera" => Ok(Device::Camera),
        "microphone" => Ok(Device::Microphone),
        "location" => Ok(Device::Location),
        _ => Err(io::Error::other("Unknown site device")),
    }
}

fn web_address(url: &str) -> io::Result<()> {
    crate::tabs::target::check_target("browser", Some(url))
}

fn now() -> i64 {
    brigadier_frames::log::now_ms() as i64
}
