//! The app's browser data commands. Agent actions use separate verbs [D515, D516, D519].

mod certs;
mod dates;
mod hub;
mod imports;
pub(crate) mod profiles;
mod store;

use brigadier_core as core;
use serde_json::Value;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::{fs, io};
use store::Store;

pub(crate) use hub::{HELP, answered};
pub use hub::{agent, leave, page, turn_ended};

const USAGE: &str = "usage: brigadier browser <session|-> profiles list|create|rename|recolour|move|make-default|delete-mark|forget|session-pick|tab-pick|resolve ... [--json]\n       brigadier browser <session|-> imports sources|origins|read|place | certs trust|clear | dates record|since|clear [--profile ID] [--json]";

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    // The agents' side: the page's answer to a call, and the user's takeover and Continue (hub.rs).
    if args.get(1).is_some_and(|a| a == "answer") || args.get(2).is_some_and(|a| a == "paused") {
        return hub::run(args);
    }
    for flag in ["--profile", "--tab", "--hue"] {
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
    if !["profiles", "imports", "certs", "dates"].contains(&area) {
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
    dates::run(&Store::open(&folder.join("browser.sqlite"))?, args)
}

fn web_address(url: &str) -> io::Result<()> {
    crate::tabs::target::check_target("browser", Some(url))
}

fn now() -> i64 {
    brigadier_frames::log::now_ms() as i64
}
