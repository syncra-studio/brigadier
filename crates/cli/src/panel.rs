//! The right panel's memory [D1014, D1033]: open or closed and its width for the whole app, in
//! `panel.json`. Every change is safe to send twice and answers the state with a `rev` that only
//! grows, so the app tells Rust's newer word from an older one [D30, D71].

use crate::{USAGE, arg};
use brigadier_core::{self as core, projects};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::{self, File};
use std::io;
use std::path::Path;

#[derive(Default, Serialize, Deserialize)]
struct Panel {
    rev: u64,
    open: bool,
    width: Option<u32>,
}

fn lock(data: &Path) -> io::Result<File> {
    projects::lock(data, "panel.lock")
}

fn read(data: &Path) -> Panel {
    (fs::read(data.join("panel.json")).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write(data: &Path, panel: &mut Panel) -> io::Result<()> {
    panel.rev += 1;
    core::write_atomic(&data.join("panel.json"), &serde_json::to_vec(panel)?)
}

fn state(panel: &Panel) -> Value {
    json!({"ok": true, "rev": panel.rev, "open": panel.open, "width": panel.width})
}

/// `panel | open on|off | width <px>`.
pub(super) fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let _lock = lock(data)?;
    let mut panel = read(data);
    match args.get(1).map(String::as_str) {
        None => Ok(state(&panel)),
        Some("open") => {
            panel.open = match arg(args, 2)? {
                "on" => true,
                "off" => false,
                _ => return Err(io::Error::other(USAGE)),
            };
            write(data, &mut panel)?;
            Ok(state(&panel))
        }
        Some("width") => {
            let width: u32 = (arg(args, 2)?.parse().ok())
                .filter(|w| (1..10_000).contains(w))
                .ok_or_else(|| io::Error::other(USAGE))?;
            panel.width = Some(width);
            write(data, &mut panel)?;
            Ok(state(&panel))
        }
        Some(_) => Err(io::Error::other(USAGE)),
    }
}
