//! The Pull requests tab's list [D258, D609]: a GitHub search of the session's repository,
//! a page of 30 at a time with Load more, each query's last read kept in
//! `pr/search.json` in the session's folder so the tab paints it at once [D207].

use super::prs::mark;
use super::view::{keep, read_kept};
use super::{Kind, NO_GH, Pr, err, gh, graphql};
use crate::adapters::iso_ms;
use brigadier_frames::log::now_ms;
use serde_json::{Value, json};
use std::io;
use std::path::{Path, PathBuf};

/// The page size [D609].
const PAGE: u32 = 30;
/// Proposed: the last reads of this many queries are kept.
const KEPT: usize = 20;

/// A row's fields: a bare row [D613].
const ROW: &str = "number url title state isDraft createdAt updatedAt additions deletions author { login avatarUrl }";

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
    /// The session repository's PRs that each query (GitHub's search words) finds, the last
    /// changed first unless it sorts, all in one read [D207]; each kept, with why when the read
    /// failed. With `after` (one query's last `next`), the next page joins the rows kept [D613].
    pub fn search(&self, queries: &[&str], after: Option<&str>) -> io::Result<Vec<Value>> {
        let Some(repo) = self.repo.as_ref().filter(|r| r.kind == Kind::GitHub) else {
            return err("Only GitHub's pull requests can be searched.");
        };
        let Some(gh) = gh(repo) else {
            return err(NO_GH);
        };
        let scope = format!("repo:{} is:pr", repo.path);
        let from = after
            .map(|a| format!(", after: {}", json!(a)))
            .unwrap_or_default();
        let (mut vars, mut declared, mut asks) = (Vec::new(), Vec::new(), String::new());
        for (i, query) in queries.iter().enumerate() {
            let sort = if query.contains("sort:") {
                ""
            } else {
                " sort:updated-desc"
            };
            vars.push((format!("q{i}"), format!("{scope} {query}{sort}")));
            declared.push(format!("$q{i}: String!"));
            asks.push_str(&format!(" l{i}: search(query: $q{i}, type: ISSUE, first: {PAGE}{from}) {{ pageInfo {{ endCursor hasNextPage }} nodes {{ ...R }} }}"));
        }
        let ask = format!(
            "query({}) {{{asks} }} fragment R on PullRequest {{ {ROW} }}",
            declared.join(", ")
        );
        let pairs: Vec<(&str, &str)> = vars.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let read = graphql(&gh, repo, &ask, &pairs);
        if let Ok((data, _)) = &read {
            super::avatars::keep(&self.avatars, data);
        }
        let one = self.one();
        let _held = one.lock().unwrap_or_else(|e| e.into_inner());
        let found: Vec<Value> = (queries.iter().enumerate())
            .map(|(i, query)| {
                let was = kept_search(&self.dir, query);
                match &read {
                    Ok((data, partial)) => {
                        let list = &data[format!("l{i}")];
                        let page = (list["nodes"].as_array().into_iter().flatten())
                            .filter(|p| p["number"].is_u64())
                            .map(|p| mark(row(p), repo));
                        // A next page joins what's kept; a first page starts it again.
                        let prs: Vec<Value> = match after {
                            Some(_) => (was["prs"].as_array().into_iter().flatten().cloned())
                                .chain(page)
                                .collect(),
                            None => page.collect(),
                        };
                        let info = &list["pageInfo"];
                        let next = (info["hasNextPage"] == true).then(|| info["endCursor"].clone());
                        json!({"query": query, "okAt": now_ms(), "error": partial, "prs": prs, "next": next})
                    }
                    Err(why) if was.is_null() => {
                        json!({"query": query, "okAt": null, "error": why, "prs": [], "next": null})
                    }
                    // The rows already read stay, with why the next didn't come.
                    Err(why) => {
                        let mut next = was;
                        next["error"] = why.clone().into();
                        next
                    }
                }
            })
            .collect();
        let all = read_kept(path(&self.dir));
        let older = (all["queries"].as_array().into_iter().flatten())
            .filter(|q| !queries.iter().any(|n| q["query"] == *n))
            .cloned();
        let kept: Vec<Value> = found.iter().cloned().chain(older).take(KEPT).collect();
        keep(&path(&self.dir), &json!({"queries": kept}));
        Ok(found)
    }
}

/// A found PR's row: its state, title, number, author, size and when it last changed [D613].
fn row(pr: &Value) -> Value {
    json!({"number": pr["number"], "title": pr["title"], "url": pr["url"],
        "state": pr["state"].as_str().map(str::to_lowercase), "draft": pr["isDraft"],
        "author": pr["author"]["login"], "additions": pr["additions"], "deletions": pr["deletions"],
        "createdAtMs": pr["createdAt"].as_str().and_then(iso_ms),
        "updatedAtMs": pr["updatedAt"].as_str().and_then(iso_ms)})
}
