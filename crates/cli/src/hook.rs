//! `brigadier hook <id> <backend>`: run by a session's terminal CLI at its hook points, with the
//! hook's input on stdin [D47]. It keeps that input in the session folder, where the terminal's
//! mirror reads it into the log, and refuses a step above Ask while the project is held [D243].
//! It prints nothing else: its output is the CLI's to read.

use brigadier_core::adapters;
use brigadier_core::{self as core};
use brigadier_frames::log;
use serde_json::{Value, json};
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::path::Path;
use std::process;

pub fn run(data: &Path, id: &str, backend: &str) -> io::Result<Value> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let hook: Value = serde_json::from_str(&input).map_err(io::Error::other)?;
    let spec = core::load(data, id)?;
    let line = json!({"hook": hook, "id": format!("h{}-{}", log::now_ms(), process::id())});
    // One write, so hooks running side by side never interleave their lines.
    (OpenOptions::new().create(true).append(true))
        .open(spec.dir.join(core::terminal::HOOKS))?
        .write_all(format!("{line}\n").as_bytes())?;
    let refusal = adapters::get(backend).and_then(|a| a.hold(&hook));
    Ok(match refusal {
        Some(r) if core::projects::held(data, &spec) => serde_json::from_str(&r)?,
        _ => Value::Null,
    })
}
