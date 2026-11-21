//! `brigadier host <id> view|list|files|search|project|session`: a session's PRs through its git host [D1030]. `view <n>`
//! reads PR n whole, `view <n> kept` answers its last read at once [D207]; `list` reads all the
//! session's PRs now (Check again); `files <n>` is its Files changed, `files <n> kept` the last
//! read [D231]; `search <query>...` is the tab's other views, GitHub's search of the repository's
//! PRs, every query in one read, `--kept` their last reads [D258], `--after <next>` one query's next
//! page [D613]; `runs <query>... [--kept]`,
//! `run <id> [kept]`, `job-log <job>` and `rerun <id> <all|failed>` are the Actions tab [D264];
//! `sides <n> <path>` is a file's two sides whole [D262]; `project <owner/name>` is the project
//! whose repository that is, or null, and `<project> session <branch>` its session whose worktree
//! is on that branch, or null, for Bring to agent [D674].
//! `<id>` may be `@`, the Code Review page, with no session or project: its PRs are named
//! `host/owner/name#n` and its search has no repository scope [D159]. The PR page's writes and the
//! reads behind them (`users`, `stack`, `generated`) take that name only [D161, D164–D166]; a
//! session's `create`, `attach`/`detach` and `compare` are its branch row's [D168, D169].

use super::arg;
use brigadier_core::{self as core, host};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

pub(super) fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    pr_run(data, args)
}

fn pr_run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    // A project's id is Home's tabs, before a session there starts [D279]; `@` the Code Review
    // page, which has neither [D159].
    if id != host::REVIEW && brigadier_core::projects::get(data, id).is_err() {
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
    if arg(args, 2)? == "session" {
        let on = Some(arg(args, 3)?);
        let held = (core::projects::sessions(data, id)?.into_iter()).find(|s| {
            let dir = core::session_dir(data, s);
            core::worktrees::present(&dir)
                && core::worktrees::branch(&dir).ok().flatten().as_deref() == on
        });
        return Ok(json!({"ok": true, "session": held}));
    }
    if let Some(done) = actions(data, id, args)? {
        return Ok(done);
    }
    if let Some(done) = writes(data, id, args)? {
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

/// Send to agent's `start --pr <n> --head <branch> [--fork] [--title T] [--url U]`: the PR's own
/// branch, fetched, which the new session's worktree is on [D674], the session named `T` after the
/// PR [D689] and its page `U` in a browser tab behind Chat [D699]. None without `--pr`, and in a
/// folder of repositories.
pub(super) fn pr_branch(
    data: &Path,
    args: &[String],
    project: &brigadier_core::projects::Project,
    spec: &core::Spec,
) -> io::Result<Option<String>> {
    let Some(n) = super::flag(args, "--pr") else {
        return Ok(None);
    };
    if let Some(title) = super::flag(args, "--title") {
        let title = super::title::clean(title).map_err(io::Error::other)?;
        core::write_atomic(&spec.dir.join("title"), title.as_bytes())?;
    }
    if let Some(url) = super::flag(args, "--url") {
        let open = [
            "tabs",
            &spec.id,
            "open",
            &format!("t-pr-{n}"),
            "browser",
            url,
            "--behind",
        ];
        // The tabs are extras: a failure here never stops the session from starting.
        let _ = super::tabs::run(data, &open.map(String::from));
    }
    if !project.kind.is_empty() {
        return Ok(None);
    }
    let n = n.parse().map_err(|_| io::Error::other("not a PR number"))?;
    let head = super::flag(args, "--head").unwrap_or_default();
    let fork = super::has(args, "--fork");
    brigadier_core::worktrees::fetch_pr(Path::new(&project.folder), n, head, fork).map(Some)
}

/// `n`, or `owner/name#n` for another repository's PR [D213]; the Code Review page's are
/// `host/owner/name#n` only [D159].
fn number(args: &[String]) -> io::Result<(Option<String>, u64)> {
    if arg(args, 1)? == host::REVIEW {
        return named(args).map(|(at, n)| (Some(at), n));
    }
    host::pr_ref(arg(args, 3)?).ok_or_else(|| io::Error::other("not a PR number"))
}

/// The PR a write names: `host/owner/name#n`, never a bare number [D159].
fn named(args: &[String]) -> io::Result<(String, u64)> {
    host::qualified(arg(args, 3)?)
        .ok_or_else(|| io::Error::other("A PR is named host/owner/name#n."))
}

/// What a write says: `--text T`, else stdin. The app's daemon runs verbs in-process, with no stdin of theirs.
fn said(args: &[String], required: bool) -> io::Result<String> {
    let mut text = String::new();
    match super::flag(args, "--text") {
        Some(t) => text = t.to_string(),
        None => _ = io::Read::read_to_string(&mut io::stdin(), &mut text)?,
    }
    match required && text.trim().is_empty() {
        true => Err(io::Error::other("Write something first.")),
        false => Ok(text.trim_end().to_string()),
    }
}

/// The PR page's writes and the reads they need [D161, D164–D169]; None for any other verb.
fn writes(data: &Path, id: &str, args: &[String]) -> io::Result<Option<Value>> {
    use host::Verdict;
    let verb = arg(args, 2)?;
    let word = |i: usize| arg(args, i);
    let mut done = match verb {
        "create" => create(data, id, args)?,
        "base" => json!({"base": host::pr(data, id)?.landing()}),
        "compare" => json!({"url": host::pr(data, id)?.compare(word(3)?, word(4)?)?}),
        "attach" | "detach" => {
            let (at, n) = named(args)?;
            host::pr(data, id)?.attach(&at, n, verb == "attach")?;
            json!({})
        }
        _ => {
            let Some(write) = WRITES.iter().find(|w| **w == verb) else {
                return Ok(None);
            };
            let (at, n) = named(args)?;
            let pr = host::pr(data, id)?;
            match *write {
                "users" => return Ok(Some(json!({"ok": true, "users": pr.users(&at, word(4)?)?}))),
                "stack" => return Ok(Some(json!({"ok": true, "stack": pr.stack(&at, n)?}))),
                "generated" => {
                    return Ok(Some(json!({"ok": true, "paths": pr.generated(&at, n)?})));
                }
                "comment" => pr.comment(&at, n, &said(args, true)?)?,
                "comment-edit" => pr.comment_edit(&at, word(4)?, &said(args, true)?)?,
                "comment-delete" => pr.comment_delete(&at, word(4)?)?,
                "react" => {
                    let on = match word(6)? {
                        "on" => true,
                        "off" => false,
                        _ => return Err(io::Error::other(super::USAGE)),
                    };
                    pr.react(&at, word(4)?, word(5)?, on)?
                }
                "edit" => match super::flag(args, "--title") {
                    Some(title) => pr.edit(&at, n, Some(title), None)?,
                    None if super::has(args, "--body") => {
                        pr.edit(&at, n, None, Some(&said(args, false)?))?
                    }
                    None => return Err(io::Error::other(super::USAGE)),
                },
                "reply" => pr.reply(&at, n, word(4)?, &said(args, true)?)?,
                "resolve" | "unresolve" => pr.resolve(&at, word(4)?, verb == "resolve")?,
                "viewed" | "unviewed" => pr.viewed(&at, n, word(4)?, verb == "viewed")?,
                "pending" => {
                    let line = |i| {
                        word(i)?
                            .parse::<u64>()
                            .map_err(|_| io::Error::other("not a line"))
                    };
                    let start = args
                        .get(7)
                        .filter(|a| *a != "--text")
                        .map(|_| line(7))
                        .transpose()?;
                    pr.pending(
                        &at,
                        n,
                        word(4)?,
                        (line(5)?, start),
                        word(6)?,
                        &said(args, true)?,
                    )?
                }
                "review" => {
                    let verdict = match word(4)? {
                        "approve" => Verdict::Approve,
                        "comment" => Verdict::Comment,
                        "changes" => Verdict::Changes,
                        _ => return Err(io::Error::other(super::USAGE)),
                    };
                    // Approve may say nothing; Comment and Request changes say why [D166].
                    let body = said(args, !matches!(verdict, Verdict::Approve))?;
                    pr.review(&at, n, verdict, &body)?
                }
                "review-discard" => pr.review_discard(&at, n)?,
                "reviewers" => {
                    let who: Vec<&str> = args.iter().skip(5).map(String::as_str).collect();
                    // Re-request asks again whoever already reviewed, as Add does.
                    match word(4)? {
                        "add" | "rerequest" => pr.reviewers(&at, n, true, &who)?,
                        "remove" => pr.reviewers(&at, n, false, &who)?,
                        _ => return Err(io::Error::other(super::USAGE)),
                    }
                }
                "merge" => {
                    let head = super::flag(args, "--head")
                        .ok_or_else(|| io::Error::other("Merge needs --head <sha>."))?;
                    pr.merge(&at, n, word(4)?, head)?
                }
                "automerge" => match word(4)? {
                    "on" => pr.automerge(&at, n, Some(word(5)?))?,
                    "off" => pr.automerge(&at, n, None)?,
                    _ => return Err(io::Error::other(super::USAGE)),
                },
                to => pr.state(&at, n, to)?,
            }
            json!({})
        }
    };
    done["ok"] = true.into();
    Ok(Some(done))
}

/// The verbs `writes` takes on a named PR.
const WRITES: [&str; 23] = [
    "users",
    "stack",
    "generated",
    "comment",
    "comment-edit",
    "comment-delete",
    "react",
    "edit",
    "reply",
    "resolve",
    "unresolve",
    "viewed",
    "unviewed",
    "pending",
    "review",
    "review-discard",
    "reviewers",
    "merge",
    "automerge",
    "close",
    "reopen",
    "draft",
    "ready",
];

/// The branch row's Create PR [D168]: `create [--branch NEW] [--commit] [--title T] [--message M]
/// [--draft] [--base B] [--head H]`, a session's only. A new branch or a commit changes the
/// checkout, so it holds the branch fence and waits for no agent working there [D1021, D1082]. An
/// empty title or message is the message writer's [D1029].
fn create(data: &Path, id: &str, args: &[String]) -> io::Result<Value> {
    if id == host::REVIEW || core::projects::get(data, id).is_ok() {
        return Err(io::Error::other("A PR is created from a session's branch."));
    }
    let pr = host::pr(data, id)?;
    let new = super::flag(args, "--branch");
    let commit = super::has(args, "--commit");
    let _fence = match new.is_some() || commit {
        true => {
            let fence = core::git::branch::fence(data)?;
            let checkout = core::git::checkout(data, &core::git::Target::session(id))?;
            let all = brigadier_frames::procs::all();
            let sharing = core::git::branch::sharing(data, &checkout);
            if (sharing.iter()).any(|id| super::sessions::working(data, id, &all)) {
                return Err(io::Error::other(
                    "Changes can't be committed while the agent is working.",
                ));
            }
            Some(fence)
        }
        false => None,
    };
    let base = super::flag(args, "--base");
    let mut title = super::flag(args, "--title")
        .unwrap_or("")
        .trim()
        .to_string();
    let mut message = super::flag(args, "--message")
        .unwrap_or("")
        .trim()
        .to_string();
    if title.is_empty() || message.is_empty() {
        let (t, m) = written(data, id, &pr.changes(base))?;
        if title.is_empty() {
            title = t;
        }
        if message.is_empty() {
            message = m;
        }
    }
    let commit_message = match message.is_empty() {
        true => title.clone(),
        false => format!("{title}\n\n{message}"),
    };
    pr.create(&host::Create {
        branch: new,
        commit: commit.then_some(commit_message.as_str()),
        title: &title,
        body: &message,
        draft: super::has(args, "--draft"),
        base,
        head: super::flag(args, "--head"),
    })
}

/// A PR's title and description, by the message writer from what the branch changes [D1029].
fn written(data: &Path, id: &str, changes: &str) -> io::Result<(String, String)> {
    let spec = core::load(data, id)?;
    let f = core::fold(&spec.dir, true)?.fold;
    let active = core::writer::writing(&spec.dir)?;
    active.lock_shared()?;
    let prompt = format!(
        "Write a pull request title on the first line (under 72 characters), then a blank line, \
         then a short description of what changed and why. Reply with only that.\n\n{changes}"
    );
    let reply = super::commit::written_for(data, &spec, &f, &active, None, |_| prompt.clone())
        .map_err(|why| io::Error::other(format!("Couldn't write the title: {why}")))?;
    let reply = core::writer::without_attribution(&reply);
    let (title, body) = reply.trim().split_once('\n').unwrap_or((reply.trim(), ""));
    Ok((title.trim().to_string(), body.trim().to_string()))
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
