//! `brigadier host <id> info|push|link|create|find`: a session's PR through its git host [D1030].
//! `link` and `create` push first and take `--title T --body B`; `create` also `--draft`.

use super::{arg, flag, has};
use brigadier_core::host;
use serde_json::{Value, json};
use std::io;
use std::path::Path;

pub(super) fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    pr_run(data, args).or_else(super::git::rejected)
}

fn pr_run(data: &Path, args: &[String]) -> io::Result<Value> {
    let pr = host::pr(data, arg(args, 1)?)?;
    let (title, body) = (
        flag(args, "--title").unwrap_or(""),
        flag(args, "--body").unwrap_or(""),
    );
    Ok(match arg(args, 2)? {
        "info" => json!({"ok": true, "info": pr.info()?}),
        "push" => {
            pr.push()?;
            json!({"ok": true})
        }
        "link" => json!({"ok": true, "url": pr.link(title, body)?}),
        "create" => json!({"ok": true, "pr": pr.create(title, body, has(args, "--draft"))?}),
        "find" => json!({"ok": true, "pr": pr.find()?}),
        _ => return Err(io::Error::other(super::USAGE)),
    })
}
