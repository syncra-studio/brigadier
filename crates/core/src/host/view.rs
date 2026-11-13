//! One PR as the Pull requests tab shows it, and its merge, through the user's own gh [D1017,
//! D1030]: one GraphQL read for the whole page [D204, D207], its checks bucketed as `gh pr checks`
//! does (`prs::checks_of`), kept in `pr/<n>.json` in the session's folder so the tab paints the last
//! read at once. A failed check's log tail is its own read, when the tab asks (`log`).

use super::prs::{FIELDS, checks_of};
use super::{GH_SECS, Gh, Pr, Repo, err, failed, gh, setup};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Proposed: a failed check's log tail is its last lines.
const TAIL_LINES: usize = 40;
const MERGE_SECS: u64 = 60;

/// What the page reads beside the list's fields.
// shortcut: its last 100 commits, comments and timeline items and 50 reviews, until a PR has more.
const PAGE: &str = "body createdAt author { login } additions deletions changedFiles mergeStateStatus labels(first: 20) { nodes { name } } assignees(first: 10) { nodes { login } } reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { name } ... on Bot { login } } } } latestReviews(first: 20) { nodes { state author { login } } } history: commits(last: 100) { totalCount nodes { commit { oid messageHeadline committedDate author { name user { login } } } } } comments(last: 100) { nodes { databaseId body createdAt url author { login __typename } } } reviews(last: 50) { nodes { databaseId state body submittedAt url author { login __typename } comments(first: 50) { nodes { databaseId path line originalLine body createdAt url author { login __typename } } } } } timelineItems(last: 100, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT, REVIEW_REQUESTED_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]) { nodes { __typename ... on HeadRefForcePushedEvent { id createdAt actor { login } } ... on ReviewRequestedEvent { id createdAt actor { login } requestedReviewer { ... on User { login } ... on Team { name } ... on Bot { login } } } ... on MergedEvent { id createdAt actor { login } } ... on ClosedEvent { id createdAt actor { login } } ... on ReopenedEvent { id createdAt actor { login } } ... on ReadyForReviewEvent { id createdAt actor { login } } ... on ConvertToDraftEvent { id createdAt actor { login } } } }";

fn kept_path(dir: &Path, number: u64) -> PathBuf {
    dir.join("pr").join(format!("{number}.json"))
}

/// PR `number`'s last read as its tab showed it, or null before any [D207].
pub fn kept_view(dir: &Path, number: u64) -> Value {
    (fs::read(kept_path(dir, number)).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

/// The open PRs whose tab the session has open (`tabs.json`): the watch reads their pages too [D207].
pub fn tabbed(dir: &Path) -> Vec<u64> {
    let tabs: Value = (fs::read(dir.join("tabs.json")).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    (tabs["tabs"].as_array().into_iter().flatten())
        .filter(|t| t["kind"] == "pr")
        .filter_map(|t| t["target"].as_str()?.parse().ok())
        .filter(|n| {
            !matches!(
                kept_view(dir, *n)["state"].as_str(),
                Some("merged" | "closed")
            )
        })
        .collect()
}

impl Pr {
    fn gh_repo(&self) -> io::Result<(&Repo, Gh)> {
        match self.repo.as_ref().and_then(|r| Some((r, gh(r)?))) {
            Some(found) => Ok(found),
            None => err(super::NO_GH),
        }
    }

    /// PR `number` whole in one read: its facts, checks, reviews, comments, commits and timeline,
    /// kept for its tab's next paint and its row in `prs.json` with it. `head` is the commit it was
    /// read at, which a merge is pinned to [D1077].
    pub fn view(&self, number: u64) -> io::Result<Value> {
        let (repo, gh) = self.gh_repo()?;
        let query = format!(
            "query($owner: String!, $name: String!) {{ repository(owner: $owner, name: $name) {{ mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod pullRequest(number: {number}) {{ ...F {PAGE} }} }} }} fragment F on PullRequest {{ {FIELDS} }}"
        );
        let (data, partial) = super::graphql(&gh, repo, &query, &[]).map_err(io::Error::other)?;
        let found = &data["repository"];
        let pr = &found["pullRequest"];
        if !pr.is_object() {
            return err(partial.unwrap_or_else(|| format!("#{number} couldn't be read.")));
        }
        // The branch's PR, or another the session touched and keeps [D175].
        let kept = super::kept(&self.dir);
        let touched = (kept["prs"].as_array().into_iter().flatten()).any(|p| p["number"] == number);
        let mine = super::prs::belongs(pr, repo, &self.branch);
        if !mine && !touched {
            return err(format!("#{number} isn't one of this session's PRs."));
        }
        let checks: Vec<Value> = checks_of(pr).iter().map(check).collect();
        let login = |a: &Value| a["login"].clone();
        let bot = |a: &Value| a["__typename"] == "Bot";
        let nodes = |v: &Value| v["nodes"].as_array().cloned().unwrap_or_default();
        // A sent review's own words, apart from its line comments; one with none says nothing here.
        // Each kind is numbered apart, so line comments carry an `r` and reviews a `v`.
        let reviews = nodes(&pr["reviews"]);
        let said = (reviews.iter()).filter(|r| {
            r["state"] != "PENDING" && r["body"].as_str().is_some_and(|b| !b.trim().is_empty())
        });
        let lines = (reviews.iter()).flat_map(|r| nodes(&r["comments"]));
        let mut comments: Vec<Value> = (nodes(&pr["comments"]).iter().map(|c| ("", c.clone())))
            .chain(lines.map(|c| ("r", c)))
            .chain(said.map(|c| ("v", c.clone())))
            .map(|(tag, c)| {
                json!({"id": format!("{tag}{}", c["databaseId"]), "author": login(&c["author"]),
                    "path": c["path"], "line": c["line"].as_u64().or(c["originalLine"].as_u64()),
                    "body": c["body"], "atMs": ms(&c["createdAt"]).or(ms(&c["submittedAt"])),
                    "url": c["url"],
                    // GitHub's own mark for an app's account, so bots fold in the tab [D1230].
                    "bot": bot(&c["author"])})
            })
            .collect();
        comments.sort_by_key(|c| c["atMs"].as_u64());
        let commits: Vec<Value> = (nodes(&pr["history"]).iter().map(|c| &c["commit"]))
            .map(|c| {
                let author = &c["author"];
                json!({"sha": c["oid"], "message": c["messageHeadline"], "atMs": ms(&c["committedDate"]),
                    "author": author["user"]["login"].as_str().or(author["name"].as_str())})
            })
            .collect();
        let author = pr["author"]["login"].clone();
        // Who's asked, then who has reviewed, as GitHub's Reviewers: the author's own notes aren't one.
        let who = |r: &Value| r["login"].as_str().or(r["name"].as_str()).map(String::from);
        let mut reviewers: Vec<Value> = (nodes(&pr["reviewRequests"]).iter())
            .filter_map(|r| who(&r["requestedReviewer"]))
            .map(|login| json!({"login": login, "state": "requested"}))
            .collect();
        for r in nodes(&pr["latestReviews"]) {
            let state = match r["state"].as_str() {
                Some("APPROVED") => "approved",
                Some("CHANGES_REQUESTED") => "changes",
                Some("COMMENTED") => "commented",
                _ => continue,
            };
            let login = login(&r["author"]);
            if login != author && reviewers.iter().all(|x| x["login"] != login) {
                reviewers.push(json!({"login": login, "state": state}));
            }
        }
        let mut events: Vec<Value> = (nodes(&pr["timelineItems"]).iter())
            .filter_map(event)
            .collect();
        for r in reviews.iter() {
            let kind = match r["state"].as_str() {
                Some("APPROVED") => "approved",
                Some("CHANGES_REQUESTED") => "changes_requested",
                _ => continue,
            };
            events.push(
                json!({"id": format!("v{}", r["databaseId"]), "atMs": ms(&r["submittedAt"]),
                "kind": kind, "actor": login(&r["author"]), "detail": null}),
            );
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
        let changes_by: Vec<Value> = (reviewers.iter())
            .filter(|r| r["state"] == "changes")
            .map(|r| r["login"].clone())
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
        // The methods the repository allows, the one GitHub offers the user first leading [D1028].
        let first = found["viewerDefaultMergeMethod"]
            .as_str()
            .map(str::to_lowercase);
        let mut styles: Vec<&str> = [
            ("mergeCommitAllowed", "merge"),
            ("squashMergeAllowed", "squash"),
            ("rebaseMergeAllowed", "rebase"),
        ]
        .into_iter()
        .filter(|(key, _)| found[key] == true)
        .map(|(_, style)| style)
        .collect();
        styles.sort_by_key(|s| Some(*s) != first.as_deref());
        if matches!(state, "open" | "draft") {
            super::note_open(&self.id, &self.branch, Some(number));
        } else if super::open_pr(&self.id, &self.branch) == Some(number) {
            super::note_open(&self.id, &self.branch, None);
        }
        let view = json!({
            "id": number.to_string(), "number": number, "title": pr["title"], "url": pr["url"],
            "body": pr["body"], "host": repo.name(), "state": state, "status": status,
            "blockers": blocked.then(|| json!({"failedChecks": failed, "changesBy": changes_by,
                "conflicts": conflicts})),
            // Off until checks pass on this head, as a merge is pinned to it [D1077, D1287].
            "merge": {"allowed": state == "open" && pr["mergeable"] == "MERGEABLE"
                    && !blocked && running == 0 && pr["reviewDecision"] != "REVIEW_REQUIRED"
                    && !styles.is_empty(),
                "default": styles.first(), "styles": styles},
            "mergeState": pr["mergeStateStatus"].as_str().map(str::to_lowercase),
            "head": pr["headRefOid"], "branch": pr["headRefName"], "base": pr["baseRefName"],
            // Its diff is the session's own branch's, which the Review tab shows [D204].
            "onBranch": mine,
            "openedBy": author, "openedAtMs": ms(&pr["createdAt"]),
            "checkedAtMs": now_ms(), "problem": partial,
            "additions": pr["additions"], "deletions": pr["deletions"], "files": pr["changedFiles"],
            "commitCount": pr["history"]["totalCount"], "commits": commits,
            "reviewers": reviewers, "assignees": nodes(&pr["assignees"]).iter().map(login).collect::<Vec<_>>(),
            "labels": nodes(&pr["labels"]).iter().map(|l| l["name"].clone()).collect::<Vec<_>>(),
            "checks": checks, "comments": comments, "events": events,
        });
        let path = kept_path(&self.dir, number);
        let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
        let wrote = fs::create_dir_all(path.parent().unwrap_or(&self.dir))
            .and_then(|()| fs::write(&tmp, view.to_string()))
            .and_then(|()| fs::rename(&tmp, &path));
        if let Err(e) = wrote {
            eprintln!("brigadier: keeping {}: {e}", path.display());
        }
        self.keep_row(pr);
        Ok(view)
    }

    /// The failed steps' last lines of the Actions job at `link`, read when the tab shows its check.
    pub fn log(&self, link: &str) -> io::Result<Option<String>> {
        let (repo, gh) = self.gh_repo()?;
        Ok(log_tail(&gh, repo, link))
    }

    /// Merges PR `number` on the host with `method`, only if its head is still `head`, the one its
    /// confirm showed [D1028, D1077]. True once the host says it's merged: with a merge queue,
    /// gh's success may only have queued it. The PR list read that records the landing is the
    /// caller's, after it answers (`list`).
    pub fn merge(&self, number: u64, method: &str, head: &str) -> io::Result<bool> {
        if !matches!(method, "merge" | "squash" | "rebase") {
            return err(format!("not a merge method: {method:?}"));
        }
        let (repo, gh) = self.gh_repo()?;
        let mut command = gh.command();
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
        let slug = format!("--repo={}/{}", repo.host, repo.path);
        let now = run_json(
            &gh,
            &["pr", "view", &number.to_string(), &slug, "--json=state"],
        );
        Ok(now.is_ok_and(|pr| pr["state"] == "MERGED"))
    }
}

fn run_json(gh: &Gh, args: &[&str]) -> io::Result<Value> {
    let mut command = gh.command();
    command.args(args);
    let out = setup::run(&mut command, GH_SECS).map_err(io::Error::other)?;
    if !out.status.success() {
        return err(failed(&out));
    }
    Ok(serde_json::from_slice(&out.stdout)?)
}

/// One check as the tab shows it; a failed one's log tail is read apart (`log`).
fn check(c: &Value) -> Value {
    let state = match c["bucket"].as_str() {
        // A cancelled check didn't pass, so it can't let Merge on.
        Some("fail" | "cancel") => "failed",
        Some("pending") => "running",
        _ => "passed",
    };
    let link = c["link"].as_str().unwrap_or("");
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
        "logTail": null, "url": c["link"], "atMs": ms(&c["completedAt"]).or(ms(&c["startedAt"]))})
}

/// The failed steps' last lines of an Actions job, from its link's job id; none for other checks.
fn log_tail(gh: &Gh, repo: &Repo, link: &str) -> Option<String> {
    let job = link.split("/job/").nth(1)?.split(['/', '?']).next()?;
    let mut command = gh.command();
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
    let kind = match e["__typename"].as_str()? {
        "HeadRefForcePushedEvent" => "force_pushed",
        "ReviewRequestedEvent" => "review_requested",
        "MergedEvent" => "merged",
        "ClosedEvent" => "closed",
        "ReopenedEvent" => "reopened",
        "ReadyForReviewEvent" => "ready",
        "ConvertToDraftEvent" => "draft",
        _ => return None,
    };
    let asked = &e["requestedReviewer"];
    let detail = asked["login"].as_str().or(asked["name"].as_str());
    Some(
        json!({"id": e["id"], "atMs": ms(&e["createdAt"]), "kind": kind,
        "actor": e["actor"]["login"], "detail": detail}),
    )
}

/// GitHub's `2026-11-11T13:49:58Z` as Unix ms; anything else is unknown.
fn ms(at: &Value) -> Option<u64> {
    crate::adapters::iso_ms(at.as_str()?)
}

fn now_ms() -> u64 {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH);
    now.map_or(0, |d| d.as_millis() as u64)
}
