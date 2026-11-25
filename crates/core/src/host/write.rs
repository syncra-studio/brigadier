//! The PR page's writes through the user's own gh [D161,
//! D164–D166]: each on a PR named `host/owner/name#n` [D159], never a bare number. GitHub's refusal
//! is the error, word for word; nothing is kept here, so the page's next read shows what landed.

use super::{GH_SECS, Gh, Pr, Repo, err, failed, github, pr_ref, setup};
use crate::git::{self, Checkout, Target};
use crate::projects::Project;
use serde_json::Value;
use std::io;
use std::path::Path;
use std::sync::atomic::AtomicBool;

/// The Code Review page's owner [D159]: no session, project or checkout, PRs named whole.
pub const REVIEW: &str = "@";

/// A PR as the Code Review page and every write name it [D159]: `host/owner/name` and its number;
/// None for a bare `n` or `owner/name#n`, which a write refuses.
pub fn qualified(target: &str) -> Option<(String, u64)> {
    let (repo, n) = pr_ref(target)?;
    repo.filter(|r| super::hosted_slug(r)).map(|r| (r, n))
}

/// The Code Review page's Pr: no session, project or checkout.
// shortcut: its folder stands in as its checkout, which nothing it runs (named reads and writes,
// search) reads as git.
pub(super) fn page(data: &Path) -> Pr {
    let dir = super::dir(data, REVIEW);
    Pr {
        id: REVIEW.into(),
        checkout: Checkout {
            root: dir.clone(),
            git_dir: dir.clone(),
            worktree: false,
        },
        branch: String::new(),
        remote: String::new(),
        base_ref: String::new(),
        base: String::new(),
        repo: None,
        scope: Vec::new(),
        record: None,
        dir,
        avatars: data.join("avatars"),
        account: None,
    }
}

/// GitHub's reactions [D165].
const REACTIONS: [&str; 8] = [
    "THUMBS_UP",
    "THUMBS_DOWN",
    "LAUGH",
    "HOORAY",
    "CONFUSED",
    "HEART",
    "ROCKET",
    "EYES",
];

/// What a review says when it's sent [D166].
pub enum Verdict {
    Approve,
    Comment,
    Changes,
}

/// A PR in `at` (`host/owner/name`) as `id`'s own tab names it whole, needing no checkout: read
/// and written as its project's account where `at` is the project's, or its card lists a PR of
/// it [D631]; else, as on the page, as any that can read it.
pub fn named(data: &Path, id: &str, at: &str) -> io::Result<Pr> {
    let page = page(data);
    if id == REVIEW {
        return Ok(page);
    }
    let dir = super::dir(data, id);
    let project = match crate::projects::get(data, id) {
        Ok(p) => Some(p),
        Err(_) => {
            let (Target::Session(sid) | Target::Repo(sid, _) | Target::Project(sid)) =
                Target::session(id);
            let project = crate::load(data, sid)?.project;
            project.and_then(|p| crate::projects::get(data, &p).ok())
        }
    };
    let account = project.and_then(|p| account(data, &p, &dir, at));
    Ok(Pr {
        id: id.into(),
        dir,
        account,
        ..page
    })
}

fn account(data: &Path, p: &Project, dir: &Path, at: &str) -> Option<String> {
    p.github_account.as_ref()?;
    let repo = super::repo(&format!("https://{at}"))?;
    let same = |r: &Repo| r.host == repo.host && r.path.eq_ignore_ascii_case(&repo.path);
    let homes: Vec<Repo> = match p.kind == crate::folder::KIND {
        true => github::homes(data, p).into_iter().map(|(_, r)| r).collect(),
        false => (git::checkout(data, &Target::Project(&p.id)).ok())
            .and_then(github::hosted)
            .map(|(_, r)| r)
            .into_iter()
            .collect(),
    };
    let listed = || {
        let (prs, start) = (super::listed(dir), format!("https://{at}/pull/"));
        (prs["prs"].as_array().into_iter().flatten()).any(|row| {
            let url = row["url"].as_str().unwrap_or("");
            (url.get(..start.len())).is_some_and(|u| u.eq_ignore_ascii_case(&start))
        })
    };
    (homes.iter().any(same) || listed())
        .then(|| github::picked(data, &p.id, Some(&repo)))
        .flatten()
        // A picked account is one server's: never another's token.
        .filter(|_| homes.iter().any(|r| r.host == repo.host))
}

impl Pr {
    /// gh on `at` (`host/owner/name`) as an account that reads it.
    fn on(&self, at: &str) -> io::Result<(Repo, Gh)> {
        if !super::hosted_slug(at) {
            return err("A PR is named host/owner/name#n.");
        }
        self.gh_repo(Some(at))
    }

    /// `gh pr <verb> <n> -R <at> <args>`, `body` on its stdin: what it printed.
    fn gh_pr(
        &self,
        at: &str,
        number: u64,
        verb: &str,
        args: &[&str],
        body: Option<&str>,
    ) -> io::Result<String> {
        let (_, gh) = self.on(at)?;
        let mut command = gh.command();
        command
            .args(["pr", verb, &number.to_string(), "-R", at])
            .args(args);
        let out = setup::run_fed(&mut command, GH_SECS, &AtomicBool::new(false), body)
            .map_err(io::Error::other)?;
        match out.status.success() {
            true => Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()),
            false => err(failed(&out)),
        }
    }

    /// One GraphQL mutation on `at`'s server; any error GitHub gives fails it.
    fn mutate(&self, at: &str, mutation: &str, vars: &[(&str, &str)]) -> io::Result<Value> {
        let (repo, gh) = self.on(at)?;
        match super::graphql(&gh, &repo, mutation, vars) {
            Ok((_, Some(why))) | Err(why) => err(why),
            Ok((data, None)) => Ok(data),
        }
    }

    /// PR `number`'s node id and the viewer's pending review on it, if any.
    fn ids(&self, at: &str, number: u64) -> io::Result<(String, Option<String>)> {
        let (repo, gh) = self.on(at)?;
        let query = format!(
            "query($owner: String!, $name: String!) {{ repository(owner: $owner, name: $name) {{ pullRequest(number: {number}) {{ id reviews(last: 1, states: PENDING) {{ nodes {{ id }} }} }} }} }}"
        );
        let (data, partial) = super::graphql(&gh, &repo, &query, &[]).map_err(io::Error::other)?;
        let pr = &data["repository"]["pullRequest"];
        let Some(id) = pr["id"].as_str() else {
            return err(partial.unwrap_or_else(|| format!("#{number} couldn't be read.")));
        };
        let pending = pr["reviews"]["nodes"][0]["id"].as_str().map(String::from);
        Ok((id.to_string(), pending))
    }

    /// A conversation comment [D165].
    pub fn comment(&self, at: &str, number: u64, body: &str) -> io::Result<()> {
        let args = ["--body-file", "-"];
        self.gh_pr(at, number, "comment", &args, Some(body))
            .map(drop)
    }

    /// A comment's new words: a conversation comment (`IC_`), a line comment (`PRRC_`) or a
    /// review's own (`PRR_`) [D165].
    pub fn comment_edit(&self, at: &str, id: &str, body: &str) -> io::Result<()> {
        let (call, key) = match kind(id)? {
            "IC" => ("updateIssueComment", "id"),
            "PRRC" => (
                "updatePullRequestReviewComment",
                "pullRequestReviewCommentId",
            ),
            _ => ("updatePullRequestReview", "pullRequestReviewId"),
        };
        let m = format!(
            "mutation($id: ID!, $body: String!) {{ {call}(input: {{{key}: $id, body: $body}}) {{ clientMutationId }} }}"
        );
        self.mutate(at, &m, &[("id", id), ("body", body)]).map(drop)
    }

    /// Deletes a conversation or line comment [D165]; a sent review can't be.
    pub fn comment_delete(&self, at: &str, id: &str) -> io::Result<()> {
        let call = match kind(id)? {
            "IC" => "deleteIssueComment",
            "PRRC" => "deletePullRequestReviewComment",
            _ => return err("A sent review can't be deleted."),
        };
        let m =
            format!("mutation($id: ID!) {{ {call}(input: {{id: $id}}) {{ clientMutationId }} }}");
        self.mutate(at, &m, &[("id", id)]).map(drop)
    }

    /// The viewer's reaction `content` on a PR, comment or review, on or off [D165].
    pub fn react(&self, at: &str, subject: &str, content: &str, on: bool) -> io::Result<()> {
        let content = content.to_ascii_uppercase();
        if !REACTIONS.contains(&content.as_str()) {
            return err(format!("{content} isn't a reaction GitHub has."));
        }
        let call = if on { "addReaction" } else { "removeReaction" };
        let m = format!(
            "mutation($id: ID!) {{ {call}(input: {{subjectId: $id, content: {content}}}) {{ clientMutationId }} }}"
        );
        self.mutate(at, &m, &[("id", subject)]).map(drop)
    }

    /// The PR's title or description [D165].
    pub fn edit(
        &self,
        at: &str,
        number: u64,
        title: Option<&str>,
        body: Option<&str>,
    ) -> io::Result<()> {
        match (title, body) {
            (Some(title), _) => self.gh_pr(at, number, "edit", &["--title", title], None),
            (None, Some(body)) => self.gh_pr(at, number, "edit", &["--body-file", "-"], Some(body)),
            (None, None) => return err("Nothing to change."),
        }
        .map(drop)
    }

    /// A reply in a review thread; into the viewer's pending review when one is open, as GitHub's
    /// own Reply does [D166].
    pub fn reply(&self, at: &str, number: u64, thread: &str, body: &str) -> io::Result<()> {
        let (_, pending) = self.ids(at, number)?;
        let mut vars = vec![("thread", thread), ("body", body)];
        let (declared, into) = match &pending {
            Some(review) => {
                vars.push(("review", review));
                (", $review: ID!", ", pullRequestReviewId: $review")
            }
            None => ("", ""),
        };
        let m = format!(
            "mutation($thread: ID!, $body: String!{declared}) {{ addPullRequestReviewThreadReply(input: {{pullRequestReviewThreadId: $thread, body: $body{into}}}) {{ clientMutationId }} }}"
        );
        self.mutate(at, &m, &vars).map(drop)
    }

    /// A review thread resolved, or opened again [D166].
    pub fn resolve(&self, at: &str, thread: &str, resolved: bool) -> io::Result<()> {
        let call = if resolved {
            "resolveReviewThread"
        } else {
            "unresolveReviewThread"
        };
        let m = format!(
            "mutation($id: ID!) {{ {call}(input: {{threadId: $id}}) {{ clientMutationId }} }}"
        );
        self.mutate(at, &m, &[("id", thread)]).map(drop)
    }

    /// A file marked viewed, or not [D166].
    pub fn viewed(&self, at: &str, number: u64, path: &str, viewed: bool) -> io::Result<()> {
        let (pr, _) = self.ids(at, number)?;
        let call = if viewed {
            "markFileAsViewed"
        } else {
            "unmarkFileAsViewed"
        };
        let m = format!(
            "mutation($pr: ID!, $path: String!) {{ {call}(input: {{pullRequestId: $pr, path: $path}}) {{ clientMutationId }} }}"
        );
        self.mutate(at, &m, &[("pr", &pr), ("path", path)])
            .map(drop)
    }

    /// A line comment into the viewer's pending review, which it starts when there's none [D166]:
    /// on `line` (from `start` for several) of `path`'s new side (`RIGHT`) or old (`LEFT`).
    pub fn pending(
        &self,
        at: &str,
        number: u64,
        path: &str,
        (line, start): (u64, Option<u64>),
        side: &str,
        body: &str,
    ) -> io::Result<()> {
        let side = side.to_ascii_uppercase();
        if !matches!(side.as_str(), "LEFT" | "RIGHT") {
            return err("A side is LEFT or RIGHT.");
        }
        let (pr, pending) = self.ids(at, number)?;
        let review = match pending {
            Some(review) => review,
            None => {
                let m = "mutation($pr: ID!) { addPullRequestReview(input: {pullRequestId: $pr}) { pullRequestReview { id } } }";
                let data = self.mutate(at, m, &[("pr", &pr)])?;
                let id = &data["addPullRequestReview"]["pullRequestReview"]["id"];
                match id.as_str() {
                    Some(id) => id.to_string(),
                    None => return err("GitHub started no review."),
                }
            }
        };
        let from = start
            .map(|s| format!(", startLine: {s}, startSide: {side}"))
            .unwrap_or_default();
        let m = format!(
            "mutation($review: ID!, $path: String!, $body: String!) {{ addPullRequestReviewThread(input: {{pullRequestReviewId: $review, path: $path, body: $body, line: {line}, side: {side}{from}}}) {{ clientMutationId }} }}"
        );
        self.mutate(
            at,
            &m,
            &[("review", &review), ("path", path), ("body", body)],
        )
        .map(drop)
    }

    /// Sends a review: the pending one with its line comments, else a new one [D164, D166].
    pub fn review(&self, at: &str, number: u64, verdict: Verdict, body: &str) -> io::Result<()> {
        let event = match verdict {
            Verdict::Approve => "APPROVE",
            Verdict::Comment => "COMMENT",
            Verdict::Changes => "REQUEST_CHANGES",
        };
        let (pr, pending) = self.ids(at, number)?;
        match pending {
            Some(review) => {
                let m = format!(
                    "mutation($review: ID!, $body: String!) {{ submitPullRequestReview(input: {{pullRequestReviewId: $review, event: {event}, body: $body}}) {{ clientMutationId }} }}"
                );
                self.mutate(at, &m, &[("review", &review), ("body", body)])
            }
            None => {
                let m = format!(
                    "mutation($pr: ID!, $body: String!) {{ addPullRequestReview(input: {{pullRequestId: $pr, event: {event}, body: $body}}) {{ clientMutationId }} }}"
                );
                self.mutate(at, &m, &[("pr", &pr), ("body", body)])
            }
        }
        .map(drop)
    }

    /// Discards the viewer's pending review and its line comments [D166].
    pub fn review_discard(&self, at: &str, number: u64) -> io::Result<()> {
        let Some(review) = self.ids(at, number)?.1 else {
            return err("There's no pending review.");
        };
        let m = "mutation($review: ID!) { deletePullRequestReview(input: {pullRequestReviewId: $review}) { clientMutationId } }";
        self.mutate(at, m, &[("review", &review)]).map(drop)
    }

    /// Reviewers asked, asked again or taken off: logins, or `org/team` [D165]. Remove me is the
    /// viewer's own login taken off.
    pub fn reviewers(&self, at: &str, number: u64, add: bool, who: &[&str]) -> io::Result<()> {
        if who.is_empty() || who.iter().any(|w| w.is_empty() || w.starts_with('-')) {
            return err("Name a reviewer.");
        }
        let flag = if add {
            "--add-reviewer"
        } else {
            "--remove-reviewer"
        };
        self.gh_pr(at, number, "edit", &[flag, &who.join(",")], None)
            .map(drop)
    }

    /// Merges by `method` (`squash`, `merge` or `rebase`) only while the head is still `head`, the
    /// one the page showed [D1077, D166].
    pub fn merge(&self, at: &str, number: u64, method: &str, head: &str) -> io::Result<()> {
        let method = method_flag(method)?;
        if head.len() < 7 || !head.chars().all(|c| c.is_ascii_hexdigit()) {
            return err("Merge needs the head commit the page shows.");
        }
        let args = [method, "--match-head-commit", head];
        self.gh_pr(at, number, "merge", &args, None).map(drop)
    }

    /// Auto-merge on by `method`, or off [D164].
    pub fn automerge(&self, at: &str, number: u64, method: Option<&str>) -> io::Result<()> {
        match method {
            Some(method) => {
                let args = ["--auto", method_flag(method)?];
                self.gh_pr(at, number, "merge", &args, None)
            }
            None => self.gh_pr(at, number, "merge", &["--disable-auto"], None),
        }
        .map(drop)
    }

    /// `close`, `reopen`, `draft` or `ready` [D161].
    pub fn state(&self, at: &str, number: u64, to: &str) -> io::Result<()> {
        match to {
            "close" | "reopen" => self.gh_pr(at, number, to, &[], None),
            "ready" => self.gh_pr(at, number, "ready", &[], None),
            "draft" => self.gh_pr(at, number, "ready", &["--undo"], None),
            _ => return err(format!("{to} isn't a PR state.")),
        }
        .map(drop)
    }
}

/// A node id's kind: `IC`, `PRRC` or `PRR`, which the comment writes take.
fn kind(id: &str) -> io::Result<&str> {
    match id.split_once('_') {
        Some((kind @ ("IC" | "PRRC" | "PRR"), rest)) if !rest.is_empty() => Ok(kind),
        _ => err(format!("{id} isn't a comment's id.")),
    }
}

fn method_flag(method: &str) -> io::Result<&'static str> {
    match method {
        "squash" => Ok("--squash"),
        "merge" => Ok("--merge"),
        "rebase" => Ok("--rebase"),
        _ => err(format!("{method} isn't a merge method.")),
    }
}
