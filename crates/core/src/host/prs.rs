//! PR discovery and check aggregation through the unmodified host CLI [D1030, D1187].

use super::{GH_SECS, Pr, Repo, failed, gh, setup, tool};
use crate::{git, worktrees};
use serde_json::{Value, json};
use std::io;
use std::sync::atomic::AtomicBool;

impl Pr {
    // shortcut: one read on focus; 2.27 adds the scheduled watcher.
    pub(super) fn prs(&self, gh: &str) -> Option<Value> {
        let repo = self.repo.as_ref()?;
        let mut command = tool(gh);
        command.args(["pr", "list", &format!("--repo={}/{}", repo.host, repo.path),
            &format!("--head={}", self.branch), "--state=all", "--limit=100",
            "--json=number,url,title,state,mergeable,reviewDecision,headRefName,headRefOid,headRepository,baseRefName,mergeCommit,statusCheckRollup"]);
        let out = setup::run(&mut command, GH_SECS).ok()?;
        if !out.status.success() {
            return None;
        }
        let list: Vec<Value> = serde_json::from_slice(&out.stdout).ok()?;
        let mine: Vec<&Value> = (list.iter())
            .filter(|p| belongs(p, repo, &self.branch))
            .collect();
        // The open one into the base, else any open one: the card's step reads it [D1287].
        let open = |p: &&&Value| p["state"] == "OPEN";
        let into = (mine.iter().filter(open)).find(|p| p["baseRefName"] == self.base);
        let open = into.or_else(|| mine.iter().find(open));
        super::note_open(
            &self.id,
            &self.branch,
            open.and_then(|p| p["number"].as_u64()),
        );
        let rows = (mine.into_iter())
            .map(|p| {
                if p["state"] == "MERGED" {
                    self.record_merge(p);
                }
                let checks = (p["state"] == "OPEN")
                    .then(|| checks(gh, repo, p))
                    .flatten();
                row(p, checks.as_deref())
            })
            .collect();
        Some(rows)
    }

    pub fn list(&self) -> Option<Value> {
        self.prs(&self.repo.as_ref().and_then(gh)?)
    }

    /// A lost create response is recovered only from this repository's head, branch and base.
    pub fn find(&self) -> io::Result<Value> {
        let Some((repo, gh)) = self.repo.as_ref().and_then(|r| Some((r, gh(r)?))) else {
            return Ok(Value::Null);
        };
        let mut command = tool(&gh);
        command.args([
            "pr",
            "list",
            &format!("--repo={}/{}", repo.host, repo.path),
            &format!("--head={}", self.branch),
            &format!("--base={}", self.base),
            "--state=open",
            "--limit=100",
            "--json=url,headRefName,headRepository",
        ]);
        let out = setup::run(&mut command, GH_SECS).map_err(io::Error::other)?;
        if !out.status.success() {
            return Err(io::Error::other(failed(&out)));
        }
        let rows: Vec<Value> = serde_json::from_slice(&out.stdout)?;
        Ok(rows
            .iter()
            .find(|p| belongs(p, repo, &self.branch))
            .and_then(|p| p["url"].as_str())
            .map_or(Value::Null, |url| self.made(url)))
    }

    fn record_merge(&self, pr: &Value) {
        let (Some(head), Some(commit)) =
            (pr["headRefOid"].as_str(), pr["mergeCommit"]["oid"].as_str())
        else {
            return;
        };
        if pr["baseRefName"] != self.base {
            return;
        }
        let Some(dir) = self.record.as_deref() else {
            return;
        };
        // The session's lock before the checkout's, as a turn start and the one button take them.
        let Ok(_one) = worktrees::lock(dir) else {
            return;
        };
        let never = AtomicBool::new(false);
        let Ok(_held) = git::lock(&self.checkout, true, &never) else {
            return;
        };
        // Failure is uncertain, never permission to discard the branch [D181, D1049].
        let _ = worktrees::external_landing(dir, &self.branch, &self.base_ref, head, commit);
    }
}

pub(super) fn belongs(pr: &Value, repo: &Repo, branch: &str) -> bool {
    pr["headRefName"] == branch
        && pr["headRepository"]["nameWithOwner"]
            .as_str()
            .is_some_and(|h| h.eq_ignore_ascii_case(&repo.path))
}

/// gh owns newest-run deduplication by name, workflow and event, including legacy contexts.
pub(super) fn checks(gh: &str, repo: &Repo, pr: &Value) -> Option<Vec<Value>> {
    // `gh pr checks` fails on a PR with none; the list's rollup, read with its head, says so.
    if pr["statusCheckRollup"]
        .as_array()
        .is_some_and(Vec::is_empty)
    {
        return Some(Vec::new());
    }
    let number = pr["number"].as_u64()?.to_string();
    let mut command = tool(gh);
    command.args([
        "pr",
        "checks",
        &number,
        &format!("--repo={}/{}", repo.host, repo.path),
        "--json=name,bucket,workflow,event,startedAt,completedAt,link",
    ]);
    let out = setup::run(&mut command, GH_SECS).ok()?;
    if !out.status.success() {
        return None;
    }
    let checks = serde_json::from_slice(&out.stdout).ok()?;
    // A new PR head between the list and checks can't borrow the previous head's check state.
    let mut command = tool(gh);
    command.args([
        "pr",
        "view",
        &number,
        &format!("--repo={}/{}", repo.host, repo.path),
        "--json=headRefOid",
    ]);
    let out = setup::run(&mut command, GH_SECS).ok()?;
    let at: Value = serde_json::from_slice(&out.stdout).ok()?;
    (out.status.success() && at["headRefOid"] == pr["headRefOid"]).then_some(checks)
}

fn row(pr: &Value, checks: Option<&[Value]>) -> Value {
    let count =
        |bucket: &str| checks.map(|checks| checks.iter().filter(|c| c["bucket"] == bucket).count());
    let (failed, running) = (count("fail"), count("pending"));
    let health = if failed.is_some_and(|n| n > 0) {
        "failed"
    } else if pr["mergeable"] == "CONFLICTING" {
        "conflicts"
    } else if pr["reviewDecision"] == "CHANGES_REQUESTED" {
        "changes"
    } else if running.is_some_and(|n| n > 0) {
        "running"
    } else if count("cancel").is_some_and(|n| n > 0) {
        "cancelled"
    } else if checks.is_none() {
        "unknown"
    } else {
        "ready"
    };
    json!({"number": pr["number"], "title": pr["title"], "url": pr["url"],
        "state": pr["state"].as_str().map(str::to_lowercase), "health": health,
        "head": pr["headRefOid"], "mergeCommit": pr["mergeCommit"]["oid"], "base": pr["baseRefName"],
        "failed": failed, "running": running, "passed": count("pass"),
        "cancelled": count("cancel"), "skipped": count("skipping"),
        "approved": match pr["reviewDecision"].as_str() {
            Some("APPROVED") => Some(true), Some("REVIEW_REQUIRED" | "CHANGES_REQUESTED") => Some(false), _ => None },
        "mergeable": match pr["mergeable"].as_str() {
            Some("MERGEABLE") => Some(true), Some("CONFLICTING") => Some(false), _ => None }})
}
