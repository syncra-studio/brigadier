//! One PR as the Pull requests tab shows it, and its merge, through the user's own gh [D1017,
//! D1030]. Checks come from `prs::checks`, gh's newest-run view with its head recheck [D1192];
//! comments and the timeline from the REST API, paginated, as `gh pr view` carries neither.

use super::{GH_SECS, Pr, Repo, err, failed, gh, setup, tool};
use serde_json::{Value, json};
use std::io;

/// Proposed: a failed check's log tail is its last lines.
const TAIL_LINES: usize = 40;
const MERGE_SECS: u64 = 60;

impl Pr {
    fn gh_repo(&self) -> io::Result<(&Repo, String)> {
        match self.repo.as_ref().and_then(|r| Some((r, gh(r)?))) {
            Some(found) => Ok(found),
            None => err("gh isn't installed or signed in here."),
        }
    }

    /// PR `number` whole: its facts, checks with failed ones' log tails, comments and timeline.
    /// `head` is the commit it was read at, which a merge is pinned to [D1077].
    pub fn view(&self, number: u64) -> io::Result<Value> {
        let (repo, gh) = self.gh_repo()?;
        let slug = format!("--repo={}/{}", repo.host, repo.path);
        let pr = run_json(
            &gh,
            &[
                "pr",
                "view",
                &number.to_string(),
                &slug,
                "--json=number,url,title,body,state,isDraft,author,createdAt,headRefName,headRefOid,headRepository,baseRefName,mergeable,reviewDecision,latestReviews,statusCheckRollup,mergeCommit",
            ],
        )?;
        if !super::prs::belongs(&pr, repo, &self.branch) {
            return err(format!("#{number} isn't this branch's PR."));
        }
        // The rest needs only the PR's number and head, so gh is asked for each at once: one by
        // one they took about 15 s on GitHub.
        let gh = gh.as_str();
        let api = |path: String| move || paged(gh, &format!("repos/{}/{path}", repo.path));
        let (known, reviews, issue, summaries, timeline, styles) = std::thread::scope(|s| {
            let known = s.spawn(|| {
                let known = super::prs::checks(gh, repo, &pr)?;
                // Each failed check's log tail is its own call, so these go at once too.
                Some(std::thread::scope(|s| {
                    let each: Vec<_> = (known.iter())
                        .map(|c| s.spawn(|| check(gh, repo, c)))
                        .collect();
                    each.into_iter()
                        .map(|h| h.join().unwrap())
                        .collect::<Vec<_>>()
                }))
            });
            let reviews = s.spawn(api(format!("pulls/{number}/comments")));
            let issue = s.spawn(api(format!("issues/{number}/comments")));
            let summaries = s.spawn(api(format!("pulls/{number}/reviews")));
            let timeline = s.spawn(api(format!("issues/{number}/timeline")));
            let styles = s.spawn(|| styles(gh, repo));
            // A panic in one is a panic here, as when they ran one by one.
            (
                known.join().unwrap(),
                reviews.join().unwrap(),
                issue.join().unwrap(),
                summaries.join().unwrap(),
                timeline.join().unwrap(),
                styles.join().unwrap(),
            )
        });
        // None when gh can't say, or the head moved meanwhile: the tab keeps its last read.
        let Some(checks) = known else {
            return err("Couldn't read the PR's checks just now.");
        };
        let (reviews, issue) = (reviews?, issue?);
        // A sent review's own words, apart from its line comments; one with none says nothing here.
        let summaries = summaries?;
        let summaries = (summaries.iter()).filter(|r| {
            r["state"] != "PENDING" && r["body"].as_str().is_some_and(|b| !b.trim().is_empty())
        });
        // Each kind is numbered apart, so line comments carry an `r` and reviews a `v`.
        let tagged = (issue.iter().map(|c| ("", c)))
            .chain(reviews.iter().map(|c| ("r", c)))
            .chain(summaries.map(|c| ("v", c)));
        let mut comments: Vec<Value> = tagged
            .map(|(tag, c)| {
                json!({"id": format!("{tag}{}", c["id"]), "author": c["user"]["login"],
                "path": c["path"], "line": c["line"].as_u64().or(c["original_line"].as_u64()),
                "body": c["body"], "atMs": ms(&c["created_at"]).or(ms(&c["submitted_at"])),
                "url": c["html_url"]})
            })
            .collect();
        comments.sort_by_key(|c| c["atMs"].as_u64());
        let mut events: Vec<Value> = timeline?.iter().filter_map(event).collect();
        events.push(
            json!({"id": "opened", "atMs": ms(&pr["createdAt"]), "kind": "opened",
            "actor": pr["author"]["login"], "detail": null}),
        );
        if let Some(e) = checks_event(&checks) {
            events.push(e);
        }
        events.sort_by_key(|e| std::cmp::Reverse(e["atMs"].as_u64()));
        let state = match (pr["state"].as_str(), pr["isDraft"] == true) {
            (Some("MERGED"), _) => "merged",
            (Some("CLOSED"), _) => "closed",
            (_, true) => "draft",
            _ => "open",
        };
        let count = |s: &str| checks.iter().filter(|c| c["state"] == s).count();
        let (failed, running) = (count("failed"), count("running"));
        let changes_by: Vec<&Value> = (pr["latestReviews"].as_array().into_iter().flatten())
            .filter(|r| r["state"] == "CHANGES_REQUESTED")
            .map(|r| &r["author"]["login"])
            .collect();
        let conflicts = pr["mergeable"] == "CONFLICTING";
        let status = match state {
            "merged" | "closed" | "draft" => state,
            _ if failed > 0 => "checks_failed",
            _ if running > 0 => "checks_running",
            _ if !changes_by.is_empty() => "changes_requested",
            _ if conflicts => "conflicts",
            _ if pr["reviewDecision"] == "REVIEW_REQUIRED" => "review_needed",
            _ => "ready",
        };
        let blocked = failed > 0 || !changes_by.is_empty() || conflicts;
        let styles = styles?;
        if matches!(state, "open" | "draft") {
            super::note_open(&self.id, &self.branch, Some(number));
        } else if super::open_pr(&self.id, &self.branch) == Some(number) {
            super::note_open(&self.id, &self.branch, None);
        }
        Ok(json!({
            "id": number.to_string(), "number": number, "title": pr["title"], "url": pr["url"],
            "body": pr["body"], "host": repo.name(), "state": state, "status": status,
            "blockers": blocked.then(|| json!({"failedChecks": failed, "changesBy": changes_by,
                "conflicts": conflicts})),
            // Off until checks pass on this head, as a merge is pinned to it [D1077, D1287].
            "merge": {"allowed": state == "open" && pr["mergeable"] == "MERGEABLE"
                    && !blocked && running == 0 && pr["reviewDecision"] != "REVIEW_REQUIRED"
                    && !styles.is_empty(),
                "default": styles.first(), "styles": styles},
            "head": pr["headRefOid"], "branch": pr["headRefName"], "base": pr["baseRefName"],
            "openedBy": pr["author"]["login"], "openedAtMs": ms(&pr["createdAt"]),
            "checkedAtMs": now_ms(), "problem": null,
            "checks": checks, "comments": comments, "events": events,
        }))
    }

    /// Merges PR `number` on the host with `method`, only if its head is still `head`, the one its
    /// confirm showed [D1028, D1077]. The PR list is read after, which records the landing. True
    /// once the host says it's merged: with a merge queue, gh's success may only have queued it.
    pub fn merge(&self, number: u64, method: &str, head: &str) -> io::Result<bool> {
        if !matches!(method, "merge" | "squash" | "rebase") {
            return err(format!("not a merge method: {method:?}"));
        }
        let (repo, gh) = self.gh_repo()?;
        let mut command = tool(&gh);
        command.env("GH_PROMPT_DISABLED", "1").args([
            "pr",
            "merge",
            &number.to_string(),
            &format!("--repo={}/{}", repo.host, repo.path),
            &format!("--{method}"),
            &format!("--match-head-commit={head}"),
        ]);
        let out = setup::run(&mut command, MERGE_SECS).map_err(io::Error::other)?;
        if !out.status.success() {
            return err(failed(&out));
        }
        let _ = self.prs(&gh);
        let slug = format!("--repo={}/{}", repo.host, repo.path);
        let now = run_json(
            &gh,
            &["pr", "view", &number.to_string(), &slug, "--json=state"],
        );
        Ok(now.is_ok_and(|pr| pr["state"] == "MERGED"))
    }
}

fn run_json(gh: &str, args: &[&str]) -> io::Result<Value> {
    let mut command = tool(gh);
    command.args(args);
    let out = setup::run(&mut command, GH_SECS).map_err(io::Error::other)?;
    if !out.status.success() {
        return err(failed(&out));
    }
    Ok(serde_json::from_slice(&out.stdout)?)
}

/// Every page of a REST list, one item per line through gh's own `--jq`.
fn paged(gh: &str, path: &str) -> io::Result<Vec<Value>> {
    let mut command = tool(gh);
    command.args(["api", "--paginate", "--jq=.[]", path]);
    let out = setup::run(&mut command, GH_SECS).map_err(io::Error::other)?;
    if !out.status.success() {
        return err(failed(&out));
    }
    Ok((String::from_utf8_lossy(&out.stdout).lines())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect())
}

/// The merge methods the repository allows, the default first: GitHub's own order.
fn styles(gh: &str, repo: &Repo) -> io::Result<Vec<&'static str>> {
    let allowed = run_json(
        gh,
        &[
            "repo",
            "view",
            &format!("{}/{}", repo.host, repo.path),
            "--json=mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
        ],
    )?;
    Ok([
        ("mergeCommitAllowed", "merge"),
        ("squashMergeAllowed", "squash"),
        ("rebaseMergeAllowed", "rebase"),
    ]
    .into_iter()
    .filter(|(key, _)| allowed[key] == true)
    .map(|(_, style)| style)
    .collect())
}

/// One check as the tab shows it; a failed Actions job's log tail comes with it.
fn check(gh: &str, repo: &Repo, c: &Value) -> Value {
    let state = match c["bucket"].as_str() {
        // A cancelled check didn't pass, so it can't let Merge on.
        Some("fail" | "cancel") => "failed",
        Some("pending") => "running",
        _ => "passed",
    };
    let link = c["link"].as_str().unwrap_or("");
    let tail = (state == "failed")
        .then(|| log_tail(gh, repo, link))
        .flatten();
    let took = ms(&c["completedAt"])
        .zip(ms(&c["startedAt"]))
        .map(|(end, start)| end.saturating_sub(start));
    // Its link names its run; one with none is known by its workflow and name.
    let id = match link {
        "" => format!(
            "{}/{}",
            c["workflow"].as_str().unwrap_or(""),
            c["name"].as_str().unwrap_or("")
        ),
        link => link.to_string(),
    };
    json!({"id": id, "name": c["name"], "state": state, "durationMs": took,
        "logTail": tail, "url": c["link"], "atMs": ms(&c["completedAt"]).or(ms(&c["startedAt"]))})
}

/// The failed steps' last lines of an Actions job, from its link's job id; none for other checks.
fn log_tail(gh: &str, repo: &Repo, link: &str) -> Option<String> {
    let job = link.split("/job/").nth(1)?.split(['/', '?']).next()?;
    let mut command = tool(gh);
    command.args([
        "run",
        "view",
        &format!("--repo={}/{}", repo.host, repo.path),
        "--job",
        job,
        "--log-failed",
    ]);
    let out = setup::run(&mut command, GH_SECS).ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // gh prefixes each line with its job, step and time: the tail keeps the line's own words.
    let lines: Vec<&str> = (text.lines())
        .map(|l| l.splitn(3, '\t').last().unwrap_or(l))
        .map(|l| match l.split_once(' ') {
            Some((at, rest)) if at.ends_with('Z') && at.contains('T') => rest,
            _ => l,
        })
        .collect();
    let tail = lines[lines.len().saturating_sub(TAIL_LINES)..].join("\n");
    (out.status.success() && !tail.is_empty()).then_some(tail)
}

/// A timeline item the tab names; the rest (labels, references…) are left out.
fn event(e: &Value) -> Option<Value> {
    let (kind, actor, at, detail) = match e["event"].as_str()? {
        "committed" => (
            "pushed",
            &e["author"]["name"],
            &e["author"]["date"],
            e["message"].as_str().and_then(|m| m.lines().next()),
        ),
        "head_ref_force_pushed" => ("pushed", &e["actor"]["login"], &e["created_at"], None),
        "reviewed" => match e["state"].as_str()? {
            "approved" => ("approved", &e["user"]["login"], &e["submitted_at"], None),
            "changes_requested" => (
                "changes_requested",
                &e["user"]["login"],
                &e["submitted_at"],
                None,
            ),
            _ => ("commented", &e["user"]["login"], &e["submitted_at"], None),
        },
        "commented" => ("commented", &e["actor"]["login"], &e["created_at"], None),
        "merged" => ("merged", &e["actor"]["login"], &e["created_at"], None),
        "closed" => ("closed", &e["actor"]["login"], &e["created_at"], None),
        _ => return None,
    };
    let id = e["id"]
        .as_u64()
        .map(|n| n.to_string())
        .or(e["sha"].as_str().map(String::from))?;
    Some(json!({"id": id, "atMs": ms(at), "kind": kind, "actor": actor, "detail": detail}))
}

/// The checks' state now, as one timeline item: the host's timeline has no check runs.
fn checks_event(checks: &[Value]) -> Option<Value> {
    let failed: Vec<&Value> = checks.iter().filter(|c| c["state"] == "failed").collect();
    let kind = match () {
        _ if !failed.is_empty() => "checks_failed",
        _ if checks.iter().any(|c| c["state"] == "running") => "checks_running",
        _ if !checks.is_empty() => "checks_passed",
        _ => return None,
    };
    let at = checks.iter().filter_map(|c| c["atMs"].as_u64()).max();
    let mut e = json!({"id": "checks", "atMs": at, "kind": kind, "actor": "", "detail": null});
    if let [one] = failed[..] {
        e["detail"] = one["name"].clone();
        e["check"] = one["id"].clone();
    }
    Some(e)
}

/// GitHub's `2026-11-11T13:49:58Z` as Unix ms; anything else is unknown.
fn ms(at: &Value) -> Option<u64> {
    let s = at.as_str()?.strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let n = |p: &str| p.parse::<i64>().ok();
    let mut d = date.split('-').map(n);
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let mut t = time.split(['.', ':']).map(n);
    let (h, min, sec) = (t.next()??, t.next()??, t.next()??);
    // Days from 1970-01-01, Howard Hinnant's days_from_civil.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    u64::try_from(((days * 24 + h) * 60 + min) * 60 + sec)
        .ok()
        .map(|s| s * 1000)
}

fn now_ms() -> u64 {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH);
    now.map_or(0, |d| d.as_millis() as u64)
}
