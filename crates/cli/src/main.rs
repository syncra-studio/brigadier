//! `brigadier`: the one way in for every drill. Each command prints one JSON line.

use serde_json::json;
use std::{env, process};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    // An agent's helper process (an adapter's channel to its CLI's server), not a command.
    if args.first().is_some_and(|a| a == "helper") {
        let helper = brigadier_core::adapters::get(args.get(1).map_or("", String::as_str));
        let done = helper.map_or(Err("unknown agent".into()), |a| a.helper(&args[2..]));
        if let Err(e) = done {
            eprintln!("{e}");
            process::exit(1);
        }
        return;
    }
    let out = brigadier::run(&brigadier_core::data_dir(), &args)
        .unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}));
    if !out.is_null() {
        println!("{out}");
    }
    process::exit(if out["ok"] == false { 1 } else { 0 });
}
