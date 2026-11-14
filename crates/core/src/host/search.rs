//! The Pull requests tab's views beyond the session's own [D258]: a GitHub search of the session's
//! repository, as its "All pull requests" page, in one GraphQL read with the Open and Closed counts
//! [D207], each query's last read kept in `pr/search.json` in the session's folder so the tab paints
//! it at once.

use super::prs::{mark, tally};
use super::view::{keep, read_kept};
use super::{Kind, NO_GH, Pr, err, gh, graphql};
use crate::adapters::iso_ms;
use brigadier_frames::log::now_ms;
use serde_json::{Value, json};
use std::io;
use std::path::{Path, PathBuf};

/// Proposed: a view's page is GitHub's 25.
const PAGE: u32 = 25;
/// Proposed: the last reads of this many queries are kept.
const KEPT: usize = 20;

/// A row's fields: the list's, with its checks counted by state rather than read one by one.
const ROW: &str = "number url title state isDraft reviewDecision createdAt updatedAt author { login } comments { totalCount } commits(last: 1) { nodes { commit { statusCheckRollup { contexts { checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }";

fn path(dir: &Path) -> PathBuf {
    dir.join("pr").join("search.json")
}

/// `query`'s last read, or null before any [D207].
pub fn kept_search(dir: &Path, query: &str) -> Value {
    read_kept(path(dir))["queries"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|q| q["query"] == query)
        .cloned()
        .unwrap_or(Value::Null)
}

impl Pr {
    /// The session repository's PRs that `query` (GitHub's search words) finds, newest first unless
    /// it sorts, with how many are open and closed; kept with why when the read failed.
    pub fn search(&self, query: &str) -> io::Result<Value> {
        let Some(repo) = self.repo.as_ref().filter(|r| r.kind == Kind::GitHub) else {
            return err("Only GitHub's pull requests can be searched.");
        };
        let Some(gh) = gh(repo) else {
            return err(NO_GH);
        };
        let words: Vec<&str> = query.split_whitespace().collect();
        let sorted = words.iter().any(|w| w.starts_with("sort:"));
        // The counts ask the same, open and then closed.
        let stateless: Vec<&str> = (words.iter().copied())
            .filter(|w| {
                !w.starts_with("state:") && !matches!(*w, "is:open" | "is:closed" | "is:merged")
            })
            .collect();
        let scope = format!("repo:{} is:pr", repo.path);
        let q = format!(
            "{scope} {query}{}",
            if sorted { "" } else { " sort:created-desc" }
        );
        let base = format!("{scope} {}", stateless.join(" "));
        let ask = format!(
            "query($q: String!, $open: String!, $closed: String!) {{ list: search(query: $q, type: ISSUE, first: {PAGE}) {{ nodes {{ ... on PullRequest {{ {ROW} }} }} }} open: search(query: $open, type: ISSUE, first: 0) {{ issueCount }} closed: search(query: $closed, type: ISSUE, first: 0) {{ issueCount }} }}"
        );
        let read = graphql(
            &gh,
            repo,
            &ask,
            &[
                ("q", &q),
                ("open", &format!("{base} state:open")),
                ("closed", &format!("{base} state:closed")),
            ],
        );
        let one = self.one();
        let _held = one.lock().unwrap_or_else(|e| e.into_inner());
        let was = kept_search(&self.dir, query);
        let next = match read {
            Ok((data, partial)) => {
                let prs: Vec<Value> = (data["list"]["nodes"].as_array().into_iter().flatten())
                    .filter(|p| p["number"].is_u64())
                    .map(|p| mark(row(p), repo))
                    .collect();
                json!({"query": query, "okAt": now_ms(), "error": partial, "prs": prs,
                    "open": data["open"]["issueCount"], "closed": data["closed"]["issueCount"]})
            }
            Err(why) if was.is_null() => {
                json!({"query": query, "okAt": null, "error": why, "prs": [], "open": null, "closed": null})
            }
            Err(why) => {
                let mut next = was;
                next["error"] = why.into();
                next
            }
        };
        let mut all = read_kept(path(&self.dir));
        let mut queries: Vec<Value> = (all["queries"].as_array().into_iter().flatten())
            .filter(|q| q["query"] != query)
            .take(KEPT - 1)
            .cloned()
            .collect();
        queries.insert(0, next.clone());
        all = json!({"queries": queries});
        keep(&path(&self.dir), &all);
        Ok(next)
    }
}

/// A found PR's row, in the session list's own words (`prs::row`) for what the tab draws.
fn row(pr: &Value) -> Value {
    let rollup = &pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"];
    let counts = (rollup["checkRunCountsByState"]
        .as_array()
        .into_iter()
        .flatten())
    .chain(
        rollup["statusContextCountsByState"]
            .as_array()
            .into_iter()
            .flatten(),
    );
    let (mut all, mut not_ok, mut failed) = (0, 0, 0);
    for c in counts {
        let n = c["count"].as_u64().unwrap_or(0) as usize;
        all += n;
        match c["state"].as_str().unwrap_or("") {
            "SUCCESS" | "SKIPPED" | "NEUTRAL" | "COMPLETED" => {}
            "FAILURE" | "ERROR" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE"
            | "CANCELLED" => {
                not_ok += n;
                failed += n;
            }
            _ => not_ok += n,
        }
    }
    json!({"number": pr["number"], "title": pr["title"], "url": pr["url"],
        "state": pr["state"].as_str().map(str::to_lowercase), "draft": pr["isDraft"],
        "author": pr["author"]["login"], "comments": pr["comments"]["totalCount"],
        "createdAtMs": pr["createdAt"].as_str().and_then(iso_ms),
        "updatedAtMs": pr["updatedAt"].as_str().and_then(iso_ms),
        "review": pr["reviewDecision"].as_str().map(str::to_lowercase),
        "checks": (rollup.is_object() && all > 0).then(|| tally(all, not_ok, failed))})
}
