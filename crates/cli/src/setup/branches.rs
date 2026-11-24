//! After Remove: `drop-branches <repo> <branch>…` deletes the kept branches at once, and
//! `put-branches <repo> <branch>=<commit>…` is its Undo.

use brigadier_core as core;
use serde_json::{Value, json};
use std::io;
use std::path::Path;

pub(super) fn drop_branches(repo: &str, args: &[String]) -> io::Result<Value> {
    let (gone, failed) =
        core::worktrees::drop_branches(Path::new(repo), &args[3.min(args.len())..])?;
    let gone: serde_json::Map<_, _> = gone.into_iter().map(|(b, c)| (b, c.into())).collect();
    Ok(json!({"ok": true, "branches": gone, "failed": failed}))
}

pub(super) fn put_branches(repo: &str, args: &[String]) -> io::Result<Value> {
    let pairs = (args.iter().skip(3))
        .map(|p| {
            p.rsplit_once('=')
                .map(|(b, c)| (b.to_string(), c.to_string()))
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| io::Error::other("put-branches takes <branch>=<commit>"))?;
    let failed = core::worktrees::put_branches(Path::new(repo), &pairs)?;
    Ok(json!({"ok": true, "failed": failed}))
}
