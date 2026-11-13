//! `brigadier host <id> view|list|log|merge`: a session's PRs through its git host [D1030]. `view <n>`
//! reads PR n whole, `view <n> kept` answers its last read at once [D207]; `list` reads all the
//! session's PRs now (Check again); `log <link>` is a failed check's log tail; `merge <n>
//! <merge|squash|rebase> <head>` merges it only while its head is still `head` [D1077].

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
    // The last read, from the session's folder alone: no git, no host [D207].
    if arg(args, 2)? == "view" && args.get(4).is_some_and(|a| a == "kept") {
        let dir = brigadier_core::session_dir(data, id);
        let (other, n) = number(args)?;
        return Ok(json!({"ok": true, "pr": host::kept_view(&dir, other.as_deref(), n)}));
    }
    let pr = host::pr(data, id)?;
    Ok(match arg(args, 2)? {
        "view" => {
            let (other, n) = number(args)?;
            json!({"ok": true, "pr": pr.view(other.as_deref(), n)?})
        }
        "list" => match pr.list() {
            Some(prs) => json!({"ok": true, "prs": prs}),
            // The read failed: `prs.json` keeps the last PRs with why, and the reply says it too.
            None => {
                let kept = host::kept(&brigadier_core::session_dir(data, id));
                return Err(io::Error::other(
                    kept["error"]
                        .as_str()
                        .unwrap_or("Couldn't check the PRs.")
                        .to_string(),
                ));
            }
        },
        "log" => json!({"ok": true, "log": pr.log(arg(args, 3)?)?}),
        "merge" => {
            let (other, n) = number(args)?;
            let merged = pr.merge(other.as_deref(), n, arg(args, 4)?, arg(args, 5)?)?;
            // The list read that records the landing goes on after the answer, so Merging… ends
            // with the merge; a shell's run that exits first leaves it to the watch.
            std::thread::spawn(move || pr.list());
            json!({"ok": true, "merged": merged})
        }
        _ => return Err(io::Error::other(super::USAGE)),
    })
}

/// `n`, or `owner/name#n` for another repository's PR [D213].
fn number(args: &[String]) -> io::Result<(Option<String>, u64)> {
    host::pr_ref(arg(args, 3)?).ok_or_else(|| io::Error::other("not a PR number"))
}
