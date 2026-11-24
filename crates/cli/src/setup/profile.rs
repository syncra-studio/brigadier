//! What onboarding keeps, in `profile.json` [D45].

use super::{agents, available};
use crate::flag;
use brigadier_core::{self as core, adapters, projects, writer};
use serde_json::{Value, json};
use std::{fs, io, path::Path};

fn read_profile(data: &Path) -> io::Result<Value> {
    match fs::read(data.join("profile.json")) {
        Ok(bytes) => Ok(Value::Object(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e),
    }
}

fn fill_writer(data: &Path, p: &mut Value) -> bool {
    if p["git_writer"].is_null()
        && let Some(first) = crate::commit::first(data)
    {
        p["git_writer"] = json!(first);
        return true;
    }
    false
}

/// The home catalogue has just been checked; save its first writer if one is still missing.
pub(super) fn checked(data: &Path) -> io::Result<Value> {
    if let Ok(p) = read_profile(data)
        && !p["git_writer"].is_null()
    {
        return Ok(p["git_writer"].clone());
    }
    let _one = projects::lock(data, "profile.lock")?;
    let mut p = read_profile(data)?;
    if fill_writer(data, &mut p) {
        core::write_atomic(&data.join("profile.json"), p.to_string().as_bytes())?;
    }
    Ok(p["git_writer"].clone())
}

/// `profile [--name N] [--intro] [--done] [--tour]`: what onboarding keeps, in `profile.json`; `--tour` marks the
/// tour offered or taken, so it never comes back on its own [D3109]. Projects are records of their own
/// (`projects`); an explicit write drops the plain paths they moved from. A missing writer is filled
/// from ready agents, and `--git-writer null` chooses that first model again when one is known.
pub(super) fn profile(data: &Path, args: &[String]) -> io::Result<Value> {
    // The plain paths move to the records before a write here drops them.
    projects::list(data)?;
    let _one = projects::lock(data, "profile.lock")?;
    let mut p = read_profile(data)?;
    if let Some(name) = flag(args, "--name") {
        p["name"] = name.trim().chars().take(80).collect::<String>().into();
    }
    let has = |f: &str| args.iter().any(|a| a == f);
    if has("--git-writer") {
        let value = flag(args, "--git-writer").ok_or_else(|| io::Error::other(crate::USAGE))?;
        p["git_writer"] = json!(writer::parse_choice(serde_json::from_str(value)?)?);
    }
    for (field, flag) in [
        ("intro_seen", "--intro"),
        ("onboarded", "--done"),
        ("tour_seen", "--tour"),
    ] {
        if has(flag) {
            p[field] = true.into();
        }
    }
    let filled = fill_writer(data, &mut p);
    if args.len() > 1 {
        p.as_object_mut().unwrap().remove("projects");
    }
    if args.len() > 1 || filled {
        core::write_atomic(&data.join("profile.json"), p.to_string().as_bytes())?;
    }
    p.as_object_mut().unwrap().remove("projects");
    p["name"] = p["name"].as_str().unwrap_or("").into();
    for field in ["intro_seen", "onboarded", "tour_seen"] {
        p[field] = (p[field] == true).into();
    }
    p["ok"] = true.into();
    if args.len() == 1 {
        p["agents"] = agents(data, &adapters::home_path(""), available(), true)?.into();
    }
    Ok(p)
}
