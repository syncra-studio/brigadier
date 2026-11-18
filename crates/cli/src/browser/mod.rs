//! The app's browser data commands. Agent actions use separate verbs [D515, D516, D519].

mod certs;
mod dates;
mod hub;
mod imports;
pub(crate) mod profiles;
mod records;
mod store;
mod types;

use brigadier_core as core;
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::{fs, io};
use store::Store;
use types::DownloadState;

pub(crate) use hub::{HELP, answered};
pub use hub::{agent, leave, page, turn_ended};

const USAGE: &str = "usage: brigadier browser <session|-> profiles list|create|rename|recolour|move|make-default|delete-mark|forget|session-pick|tab-pick|resolve ... [--json]\n       brigadier browser <session|-> downloads list|start|finish|finished|remove|clear|interrupt | imports sources|origins|read|place | certs trust|clear | dates record|since|clear [--profile ID] [--json]";

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
        "--query",
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
    if !["profiles", "downloads", "imports", "certs", "dates"].contains(&area) {
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
    if area == "certs" {
        return certs::run(&folder, args);
    }
    if area == "imports" {
        return imports::run(data, &profile, args);
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
        ("downloads", "list") => Ok(
            json!({"ok": true, "downloads": store.downloads(crate::flag(args, "--query").unwrap_or("")).map_err(sql)?}),
        ),
        ("downloads", "start") => {
            // A web app's own file comes from a blob: address, which no tab may load but a download may.
            if !get(1)?.starts_with("blob:") {
                web_address(get(1)?)?;
            }
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

fn web_address(url: &str) -> io::Result<()> {
    crate::tabs::target::check_target("browser", Some(url))
}

fn now() -> i64 {
    brigadier_frames::log::now_ms() as i64
}
