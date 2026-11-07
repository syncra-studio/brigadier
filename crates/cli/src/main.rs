//! `brigadier`: the one way in for every drill. Each command prints one JSON line.

use serde_json::json;
use std::{env, process};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let out = brigadier::run(&brigadier_core::data_dir(), &args)
        .unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}));
    if !out.is_null() {
        println!("{out}");
    }
    process::exit(if out["ok"] == false { 1 } else { 0 });
}
