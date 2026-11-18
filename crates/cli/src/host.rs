//! `brigadier host <id> view|list|files|search|project`: a session's PRs through its git host [D1030]. `view <n>`
//! reads PR n whole, `view <n> kept` answers its last read at once [D207]; `list` reads all the
//! session's PRs now (Check again); `files <n>` is its Files changed, `files <n> kept` the last
//! read [D231]; `search <query>...` is the tab's other views, GitHub's search of the repository's
//! PRs, every query in one read, `--kept` their last reads [D258], `--after <next>` one query's next
//! page [D613]; `runs <query>... [--kept]`,
//! `run <id> [kept]`, `job-log <job>` and `rerun <id> <all|failed>` are the Actions tab [D264];
//! `sides <n> <path>` is a file's two sides whole [D262]; `project <owner/name>` is the project
//! whose repository that is, or null, for Bring to agent [D674].

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
    // Several queries at once, the side views' as the tab opens: one read, or their last [D207, D258].
    if arg(args, 2)? == "search" {
        // `--after <cursor>`: one query's next page [D613].
        let after = args.iter().position(|a| a == "--after");
        let queries: Vec<&str> = (args.iter().enumerate().skip(3))
            .filter(|(i, a)| *a != "--kept" && after.is_none_or(|p| *i != p && *i != p + 1))
            .map(|(_, a)| a.as_str())
            .collect();
        if args.iter().any(|a| a == "--kept") {
            let dir = host::dir(data, id);
            let found: Vec<_> = queries.iter().map(|q| host::kept_search(&dir, q)).collect();
            return Ok(json!({"ok": true, "found": found}));
        }
        let after = after.and_then(|p| args.get(p + 1)).map(String::as_str);
        return Ok(json!({"ok": true, "found": host::pr(data, id)?.search(&queries, after)?}));
    }
    if arg(args, 2)? == "project" {
        return Ok(json!({"ok": true, "project": host::project_of(data, arg(args, 3)?)}));
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
        _ => return Err(io::Error::other(super::USAGE)),
    })
}

/// Bring to agent's `start --pr <n> --head <branch> [--fork]`: the PR's own branch, fetched, which
/// the new session's worktree is on [D674]. None without `--pr`, and in a folder of repositories.
pub(super) fn pr_branch(
    args: &[String],
    project: &brigadier_core::projects::Project,
) -> io::Result<Option<String>> {
    let (Some(n), true) = (super::flag(args, "--pr"), project.kind.is_empty()) else {
        return Ok(None);
    };
    let n = n.parse().map_err(|_| io::Error::other("not a PR number"))?;
    let head = super::flag(args, "--head").unwrap_or_default();
    let fork = super::has(args, "--fork");
    brigadier_core::worktrees::fetch_pr(Path::new(&project.folder), n, head, fork).map(Some)
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
