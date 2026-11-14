//! `brigadier host <id> view|list|log|merge`: a session's PRs through its git host [D1030]. `view <n>`
//! reads PR n whole, `view <n> kept` answers its last read at once [D207]; `list` reads all the
//! session's PRs now (Check again); `files <n>` is its Files changed, `files <n> kept` the last
//! read [D231]; `search <query>...` is the tab's other views, GitHub's search of the repository's
//! PRs, every query in one read, `--kept` their last reads [D258]; `runs <query>... [--kept]`,
//! `run <id> [kept]`, `job-log <job>` and `rerun <id> <all|failed>` are the Actions tab [D264]; `log <link>` is a failed check's log tail; `merge <n>
//! <merge|squash|rebase> <head>` merges it only while its head is still `head` [D1077]; `comment
//! <n> <body>` posts a comment on it [D260]; `sides <n>
//! <path>` is a file's two sides whole, `review <n> <json>` submits a review [D262].

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
    // A project's id is Home's tabs, before a session there starts [D279].
    if brigadier_core::projects::get(data, id).is_err() {
        brigadier_core::load(data, id)?;
    }
    // Landing is the folder owner's alone; all of these wait for no other session's turn [D1082].
    if arg(args, 2)? == "merge"
        && let Some(owner) = brigadier_core::share::lands(data, id)
    {
        return Err(io::Error::other(format!(
            "Landing stays with {owner} while it's there."
        )));
    }
    // Several queries at once, the side views' as the tab opens: one read, or their last [D207, D258].
    if arg(args, 2)? == "search" {
        let queries: Vec<&str> = args[3..]
            .iter()
            .map(String::as_str)
            .filter(|a| *a != "--kept")
            .collect();
        if args.iter().any(|a| a == "--kept") {
            let dir = host::dir(data, id);
            let found: Vec<_> = queries.iter().map(|q| host::kept_search(&dir, q)).collect();
            return Ok(json!({"ok": true, "found": found}));
        }
        return Ok(json!({"ok": true, "found": host::pr(data, id)?.search(&queries)?}));
    }
    if let Some(done) = actions(data, id, args)? {
        return Ok(done);
    }
    // The last read, from the session's folder alone: no git, no host [D207].
    // (A comment's words are never this, even when they read "kept".)
    if matches!(arg(args, 2)?, "view" | "files") && args.get(4).is_some_and(|a| a == "kept") {
        let dir = host::dir(data, id);
        let (other, n) = number(args)?;
        return Ok(match arg(args, 2)? {
            "view" => json!({"ok": true, "pr": host::kept_view(&dir, other.as_deref(), n)}),
            "files" => json!({"ok": true, "files": host::kept_files(&dir, other.as_deref(), n)}),
            _ => return Err(io::Error::other(super::USAGE)),
        });
    }
    let pr = host::pr(data, id)?;
    Ok(match arg(args, 2)? {
        "view" => {
            let (other, n) = number(args)?;
            json!({"ok": true, "pr": pr.view(other.as_deref(), n)?})
        }
        "files" => {
            let (other, n) = number(args)?;
            json!({"ok": true, "files": pr.files(other.as_deref(), n)?})
        }
        "list" => match pr.list() {
            Some(prs) => json!({"ok": true, "prs": prs}),
            // The read failed: `prs.json` keeps the last PRs with why, and the reply says it too.
            None => {
                let kept = host::kept(&host::dir(data, id));
                return Err(io::Error::other(
                    kept["error"]
                        .as_str()
                        .unwrap_or("Couldn't check the PRs.")
                        .to_string(),
                ));
            }
        },
        "sides" => {
            let (other, n) = number(args)?;
            json!({"ok": true, "sides": pr.sides(other.as_deref(), n, arg(args, 4)?)?})
        }
        "review" => {
            let (other, n) = number(args)?;
            let review: Value = serde_json::from_str(arg(args, 4)?)?;
            pr.review(other.as_deref(), n, &review)?;
            json!({"ok": true})
        }
        "log" => json!({"ok": true, "log": pr.log(arg(args, 3)?)?}),
        "comment" => {
            let (other, n) = number(args)?;
            json!({"ok": true, "comment": pr.comment(other.as_deref(), n, arg(args, 4)?)?})
        }
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

/// The Actions tab's [D264]: runs by GitHub's search words (`--kept`: their last reads), a run's
/// page (`kept`: its last read), a finished job's log, and a re-run; None for any other.
fn actions(data: &Path, id: &str, args: &[String]) -> io::Result<Option<Value>> {
    let dir = || host::dir(data, id);
    let run = || {
        arg(args, 3)?
            .parse::<u64>()
            .map_err(|_| io::Error::other("not a run id"))
    };
    let mut done = match arg(args, 2)? {
        "runs" => {
            let queries: Vec<&str> = (args[3..].iter().map(String::as_str))
                .filter(|a| *a != "--kept")
                .collect();
            match args.iter().any(|a| a == "--kept") {
                true => host::kept_runs(&dir(), &queries),
                false => host::pr(data, id)?.runs(&queries)?,
            }
        }
        "run" if args.get(4).is_some_and(|a| a == "kept") => {
            json!({"run": host::kept_run(&dir(), run()?)})
        }
        "run" => json!({"run": host::pr(data, id)?.run(run()?)?}),
        "job-log" => json!({"log": host::pr(data, id)?.job_log(run()?)?}),
        "rerun" => {
            let failed = match arg(args, 4)? {
                "all" => false,
                "failed" => true,
                _ => return Err(io::Error::other(super::USAGE)),
            };
            host::pr(data, id)?.rerun(run()?, failed)?;
            json!({})
        }
        _ => return Ok(None),
    };
    done["ok"] = true.into();
    Ok(Some(done))
}
