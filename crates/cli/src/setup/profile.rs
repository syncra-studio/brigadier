//! What onboarding keeps, in `profile.json` [D45].

use super::{agents, available};
use crate::flag;
use brigadier_core::{self as core, adapters, projects, writer};
use serde_json::{Value, json};
use std::sync::Mutex;
use std::{fs, io, path::Path};

static PROFILE: Mutex<()> = Mutex::new(());

fn read_profile(data: &Path) -> Value {
    let p: Value = fs::read(data.join("profile.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    json!({"name": p["name"].as_str().unwrap_or(""), "git_writer": p["git_writer"], "intro_seen": p["intro_seen"] == true,
        "onboarded": p["onboarded"] == true, "tour_seen": p["tour_seen"] == true})
}

/// `profile [--name N] [--intro] [--done] [--tour]`: what onboarding keeps, in `profile.json`; `--tour` marks the
/// tour offered or taken, so it never comes back on its own [D3109]. Projects are records of their own
/// (`projects`); a write here drops the plain paths they moved from.
pub(super) fn profile(data: &Path, args: &[String]) -> io::Result<Value> {
    let _one = PROFILE.lock().unwrap();
    // The plain paths move to the records before a write here drops them.
    projects::list(data)?;
    let mut p = read_profile(data);
    if let Some(name) = flag(args, "--name") {
        p["name"] = name.trim().chars().take(80).collect::<String>().into();
    }
    let has = |f: &str| args.iter().any(|a| a == f);
    if has("--git-writer") {
        let value = flag(args, "--git-writer").ok_or_else(|| io::Error::other(crate::USAGE))?;
        p["git_writer"] = json!(writer::parse_choice(serde_json::from_str(value)?)?);
    }
    p["intro_seen"] = (p["intro_seen"] == true || has("--intro")).into();
    p["onboarded"] = (p["onboarded"] == true || has("--done")).into();
    p["tour_seen"] = (p["tour_seen"] == true || has("--tour")).into();
    if args.len() > 1 {
        fs::create_dir_all(data)?;
        core::write_atomic(&data.join("profile.json"), p.to_string().as_bytes())?;
    }
    p["ok"] = true.into();
    if args.len() == 1 {
        p["agents"] = agents(data, &adapters::home_path(""), available(), true)?.into();
    }
    Ok(p)
}
