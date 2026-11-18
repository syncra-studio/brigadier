//! One PR as the Pull requests tab shows it, through the user's own gh [D1017, D1030]: one GraphQL
//! read for the whole page [D204, D207], its checks bucketed as `gh pr checks` does
//! (`prs::checks_of`), kept in `pr/<n>.json` in the session's folder (`pr/<owner>/<name>/<n>.json`
//! for another repository's [D213]) so the tab paints the last read at once.

use super::prs::{FIELDS, checks_of};
use super::timeline::{bot, hidden, nodes, state_of, timeline};
use super::{GH_SECS, Gh, Pr, Repo, err, failed, gh, setup};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// What the page reads beside the list's fields: GitHub's Conversation, its review threads and the
/// timeline events it draws [D260]; its comments as `talk`, apart from the fields' count of them.
// shortcut: its last 100 commits, comments and timeline items, 50 reviews and 50 threads, until a PR has more.
const PAGE: &str = "body createdAt author { login avatarUrl url } repository { url } headRef { name } labels(first: 20) { nodes { name } } additions deletions changedFiles mergeStateStatus reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login avatarUrl } ... on Team { name } ... on Bot { login avatarUrl } } } } latestReviews(first: 20) { nodes { state author { login avatarUrl } } } history: commits(last: 100) { totalCount nodes { commit { oid messageHeadline committedDate author { name user { login } } } } } talk: comments(last: 100) { nodes { databaseId body createdAt url isMinimized minimizedReason author { login avatarUrl __typename } } } reviews(last: 50) { nodes { databaseId state body submittedAt url isMinimized minimizedReason author { login avatarUrl __typename } } } reviewThreads(last: 50) { nodes { id isResolved isOutdated comments(first: 50) { nodes { databaseId path line originalLine body createdAt url author { login avatarUrl __typename } pullRequestReview { databaseId } } } } } timelineItems(last: 100, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT, REVIEW_REQUESTED_EVENT, REVIEW_DISMISSED_EVENT, DEPLOYED_EVENT, CROSS_REFERENCED_EVENT, MERGED_EVENT, HEAD_REF_DELETED_EVENT, CLOSED_EVENT, REOPENED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]) { nodes { __typename ... on HeadRefForcePushedEvent { id createdAt actor { login avatarUrl __typename } } ... on ReviewRequestedEvent { id createdAt actor { login avatarUrl __typename } requestedReviewer { ... on User { login avatarUrl } ... on Team { name } ... on Bot { login avatarUrl } } } ... on ReviewDismissedEvent { id createdAt actor { login avatarUrl __typename } previousReviewState review { databaseId author { login avatarUrl } } pullRequestCommit { commit { oid } } } ... on DeployedEvent { id createdAt actor { login avatarUrl __typename } deployment { environment latestStatus { environmentUrl logUrl } } } ... on CrossReferencedEvent { id createdAt actor { login avatarUrl __typename } source { ... on PullRequest { number title url state isDraft } ... on Issue { number title url state } } } ... on MergedEvent { id createdAt actor { login avatarUrl __typename } commit { oid } mergeRefName } ... on HeadRefDeletedEvent { id createdAt actor { login avatarUrl __typename } headRefName } ... on ClosedEvent { id createdAt actor { login avatarUrl __typename } } ... on ReopenedEvent { id createdAt actor { login avatarUrl __typename } } ... on ReadyForReviewEvent { id createdAt actor { login avatarUrl __typename } } ... on ConvertToDraftEvent { id createdAt actor { login avatarUrl __typename } } } }";

/// `other`: another repository's `owner/name`, checked to be one (`slug`) [D213]. `what`: `json`
/// for the page, `files.json` for its Files changed [D231].
fn kept_path(dir: &Path, other: Option<&str>, number: u64, what: &str) -> PathBuf {
    other
        .map_or(dir.join("pr"), |r| dir.join("pr").join(r))
        .join(format!("{number}.{what}"))
}

pub(super) fn read_kept(path: PathBuf) -> Value {
    (fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

pub(super) fn keep(path: &Path, value: &Value) {
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let wrote = fs::create_dir_all(path.parent().unwrap_or(path))
        .and_then(|()| fs::write(&tmp, value.to_string()))
        .and_then(|()| fs::rename(&tmp, path));
    if let Err(e) = wrote {
        eprintln!("brigadier: keeping {}: {e}", path.display());
    }
}

/// PR `number`'s last read as its tab showed it, or null before any [D207].
pub fn kept_view(dir: &Path, other: Option<&str>, number: u64) -> Value {
    read_kept(kept_path(dir, other, number, "json"))
}

/// PR `number`'s Files changed as last read, or null before any [D231].
pub fn kept_files(dir: &Path, other: Option<&str>, number: u64) -> Value {
    read_kept(kept_path(dir, other, number, "files.json"))
}

/// The open PRs whose tab the session has open (`tabs.json`): the watch reads their pages too [D207].
pub fn tabbed(dir: &Path) -> Vec<(Option<String>, u64)> {
    let tabs: Value = (fs::read(dir.join("tabs.json")).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    (tabs["tabs"].as_array().into_iter().flatten())
        .filter(|t| t["kind"] == "pr")
        .filter_map(|t| super::pr_ref(t["target"].as_str()?))
        .filter(|(other, n)| {
            !matches!(
                kept_view(dir, other.as_deref(), *n)["state"].as_str(),
                Some("merged" | "closed")
            )
        })
        .collect()
}

impl Pr {
    /// The session's repository, or `other` on its server [D213], and gh as an account that reads it.
    pub(super) fn gh_repo(&self, other: Option<&str>) -> io::Result<(Repo, Gh)> {
        let repo = (self.repo.as_ref()).map(|r| other.map_or_else(|| r.clone(), |o| r.at(o)));
        match repo
            .and_then(|r| Some((gh(&r, self.account.as_deref())?, r)))
            .map(|(gh, r)| (r, gh))
        {
            Some(found) => Ok(found),
            None => err(super::NO_GH),
        }
    }

    /// PR `number` whole in one read: its facts, checks, reviews, comments, commits and timeline,
    /// kept for its tab's next paint and its row in `prs.json` with it. `head` is the commit it was
    /// read at, which a merge is pinned to [D1077].
    pub fn view(&self, other: Option<&str>, number: u64) -> io::Result<Value> {
        let (repo, gh) = self.gh_repo(other)?;
        let repo = &repo;
        let query = format!(
            "query($owner: String!, $name: String!) {{ repository(owner: $owner, name: $name) {{ pullRequest(number: {number}) {{ ...F {PAGE} }} }} }} fragment F on PullRequest {{ {FIELDS} }}"
        );
        let (data, partial) = super::graphql(&gh, repo, &query, &[]).map_err(io::Error::other)?;
        super::avatars::keep(&self.avatars, &data);
        let found = &data["repository"];
        let pr = &found["pullRequest"];
        if !pr.is_object() {
            return err(partial.unwrap_or_else(|| format!("#{number} couldn't be read.")));
        }
        // Any PR the tab lists opens; only the card keeps to the session's [D283, D175].
        let mine = other.is_none() && super::prs::belongs(pr, repo, &self.branch);
        let checks: Vec<Value> = checks_of(pr).iter().map(check).collect();
        let login = |a: &Value| a["login"].clone();
        // A sent review's own words, apart from its line comments; one with none says nothing here.
        // Each kind is numbered apart, so line comments carry an `r` and reviews a `v`.
        let reviews = nodes(&pr["reviews"]);
        let said = (reviews.iter()).filter(|r| {
            r["state"] != "PENDING" && r["body"].as_str().is_some_and(|b| !b.trim().is_empty())
        });
        let threads = nodes(&pr["reviewThreads"]);
        let lines = (threads.iter()).flat_map(|t| nodes(&t["comments"]));
        let mut comments: Vec<Value> = (nodes(&pr["talk"]).iter().map(|c| ("", c.clone())))
            .chain(lines.map(|c| ("r", c)))
            .chain(said.map(|c| ("v", c.clone())))
            .map(|(tag, c)| {
                json!({"id": format!("{tag}{}", c["databaseId"]), "author": login(&c["author"]),
                    "path": c["path"], "line": c["line"].as_u64().or(c["originalLine"].as_u64()),
                    "body": c["body"], "atMs": ms(&c["createdAt"]).or(ms(&c["submittedAt"])),
                    "url": c["url"],
                    // GitHub's own mark for an app's account: its Bot label.
                    "bot": bot(&c["author"]),
                    // Hidden as GitHub hides it ("outdated", "resolved"…), shown on a click.
                    "minimized": hidden(&c)})
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
        let state = state_of(pr);
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
        // Only the branch's own PR is its open one.
        if mine && matches!(state, "open" | "draft") {
            super::note_open(&self.id, &self.branch, Some(number));
        } else if mine && super::open_pr(&self.id, &self.branch) == Some(number) {
            super::note_open(&self.id, &self.branch, None);
        }
        let view = json!({
            "id": number.to_string(), "number": number, "title": pr["title"], "url": pr["url"],
            "body": pr["body"], "host": repo.name(), "repo": repo.path, "state": state, "status": status,
            "labels": nodes(&pr["labels"]).iter().map(|l| l["name"].clone()).collect::<Vec<_>>(),
            "blockers": blocked.then(|| json!({"failedChecks": failed, "changesBy": changes_by,
                "conflicts": conflicts})),
            "mergeState": pr["mergeStateStatus"].as_str().map(str::to_lowercase),
            "head": pr["headRefOid"], "branch": pr["headRefName"], "base": pr["baseRefName"],
            // Its branch in another repository, or deleted: Bring to agent fetches it by number [D674].
            "fork": pr["headRef"].is_null() || !(pr["headRepository"]["nameWithOwner"].as_str())
                .is_some_and(|h| h.eq_ignore_ascii_case(&repo.path)),
            // Its diff is the session's own branch's, which the Review tab shows [D204].
            "onBranch": mine,
            "openedBy": author, "openedAtMs": ms(&pr["createdAt"]),
            // Their pages on the host, which the tab's header opens [D656].
            // A deleted branch has no page.
            "links": {"author": pr["author"]["url"], "repo": pr["repository"]["url"],
                "branch": (pr["headRepository"]["url"].as_str()).zip(pr["headRef"]["name"].as_str())
                    .map(|(repo, branch)| format!("{repo}/tree/{}", crate::adapters::encode(branch)))},
            "checkedAtMs": now_ms(), "problem": partial,
            "additions": pr["additions"], "deletions": pr["deletions"], "files": pr["changedFiles"],
            "commitCount": pr["history"]["totalCount"], "commits": commits,
            "reviewers": reviewers, "checks": checks, "comments": comments, "events": events,
            "timeline": timeline(pr, &commits, &reviews, &threads),
        });
        keep(&kept_path(&self.dir, other, number, "json"), &view);
        self.keep_row(pr, mine);
        Ok(view)
    }

    /// PR `number`'s changed files with GitHub's patch of each, as the Review tab draws them, in one
    /// paged read and kept [D231]. Only a PR whose page was read (and so found the session's) is read.
    /// GitHub lists up to 3000 files and leaves out a large file's patch: `total` says how many changed.
    pub fn files(&self, other: Option<&str>, number: u64) -> io::Result<Value> {
        let page = kept_view(&self.dir, other, number);
        if page.is_null() {
            return err(format!("#{number} isn't one of this session's PRs."));
        }
        let (repo, gh) = self.gh_repo(other)?;
        let mut command = gh.command();
        command.args([
            "api",
            "--hostname",
            &repo.host,
            "--paginate",
            &format!("repos/{}/pulls/{number}/files?per_page=100", repo.path),
        ]);
        let out = setup::run(&mut command, GH_SECS).map_err(io::Error::other)?;
        if !out.status.success() {
            return err(failed(&out));
        }
        // --paginate prints each page's array after the last.
        let pages = serde_json::Deserializer::from_slice(&out.stdout).into_iter::<Vec<Value>>();
        let mut files = Vec::new();
        for page in pages {
            files.extend(page?.iter().map(file));
        }
        let sum = |key: &str| files.iter().filter_map(|f| f[key].as_u64()).sum::<u64>();
        let view = json!({"scope": "branch", "base": page["base"], "head": page["head"],
            "insertions": sum("insertions"), "deletions": sum("deletions"),
            "total": page["files"].as_u64().unwrap_or(files.len() as u64),
            "checkedAtMs": now_ms(), "files": files});
        keep(&kept_path(&self.dir, other, number, "files.json"), &view);
        Ok(view)
    }
}

/// One check as the tab shows it.
fn check(c: &Value) -> Value {
    let state = match c["bucket"].as_str() {
        // A cancelled check didn't pass, so it can't let Merge on.
        Some("fail" | "cancel") => "failed",
        Some("pending") => "running",
        Some("skipping") => "skipped",
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

/// One of GitHub's PR files as a Review file, its patch under the file headers the diff draws by;
/// null where GitHub sent none (a binary or too large file).
fn file(f: &Value) -> Value {
    let path = f["filename"].as_str().unwrap_or("");
    let from = f["previous_filename"].as_str();
    let status = match f["status"].as_str() {
        Some("added") => "added",
        Some("removed") => "deleted",
        Some("renamed") => "renamed",
        Some("copied") => "copied",
        _ => "modified",
    };
    let (old, new) = match status {
        "added" => ("/dev/null".to_string(), format!("b/{path}")),
        "deleted" => (format!("a/{path}"), "/dev/null".to_string()),
        _ => (format!("a/{}", from.unwrap_or(path)), format!("b/{path}")),
    };
    let patch = f["patch"]
        .as_str()
        .map(|p| format!("--- {old}\n+++ {new}\n{p}\n"));
    let (insertions, deletions) = (
        f["additions"].as_u64().unwrap_or(0),
        f["deletions"].as_u64().unwrap_or(0),
    );
    json!({"path": path, "from": from, "status": status, "insertions": insertions,
        "deletions": deletions, "binary": patch.is_none() && insertions + deletions == 0,
        "staged": false, "large": false, "patch": patch})
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
pub(super) fn ms(at: &Value) -> Option<u64> {
    crate::adapters::iso_ms(at.as_str()?)
}

fn now_ms() -> u64 {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH);
    now.map_or(0, |d| d.as_millis() as u64)
}
