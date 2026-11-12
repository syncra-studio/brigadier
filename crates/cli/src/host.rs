//! `brigadier host <id> view|merge`: a session's PR through its git host [D1030]. `view <n>` reads
//! PR n whole; `merge <n> <merge|squash|rebase> <head>` merges it only while its head is still
//! `head` [D1077].

use super::arg;
use brigadier_core::host;
use serde_json::{Value, json};
use std::io;
use std::path::Path;

pub(super) fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    pr_run(data, args)
}

fn pr_run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    brigadier_core::load(data, id)?;
    // Landing is the folder owner's alone; all of these wait for no other session's turn [D1082].
    if arg(args, 2)? == "merge"
        && let Some(owner) = brigadier_core::share::lands(data, id)
    {
        return Err(io::Error::other(format!(
            "Landing stays with {owner} while it's there."
        )));
    }
    let pr = host::pr(data, id)?;
    Ok(match arg(args, 2)? {
        "view" => json!({"ok": true, "pr": pr.view(number(args)?)?}),
        "merge" => {
            let merged = pr.merge(number(args)?, arg(args, 4)?, arg(args, 5)?)?;
            // The list read that records the landing goes on after the answer, so Merging… ends
            // with the merge; a shell's run that exits first leaves it to the watch.
            std::thread::spawn(move || pr.list());
            json!({"ok": true, "merged": merged})
        }
        _ => return Err(io::Error::other(super::USAGE)),
    })
}

fn number(args: &[String]) -> io::Result<u64> {
    (arg(args, 3)?.parse()).map_err(|_| io::Error::other("not a PR number"))
}
