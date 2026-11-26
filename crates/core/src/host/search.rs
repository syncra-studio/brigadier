//! The Pull requests tab's list [D258, D609]: a GitHub search of the session's repository,
//! a page of 30 at a time with Load more, each query's last read kept in
//! `pr/search.json` in the session's folder so the tab paints it at once [D207].

use super::prs::mark;
use super::view::{keep, read_kept};
use super::{Gh, Kind, NO_GH, Pr, Repo, accounts, err, gh, graphql, setup, token};
use crate::adapters::iso_ms;
use brigadier_frames::log::now_ms;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

/// The page size [D609].
const PAGE: u32 = 30;
/// Proposed: the last reads of this many queries are kept, enough for the Pull Requests inbox's
/// views (three queries each, per state, account and project) to paint again after a relaunch [D262].
const KEPT: usize = 60;

/// A row's fields [D613].
const ROW: &str = "number url title state isDraft headRefName baseRefName createdAt updatedAt additions deletions author { login avatarUrl } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }";

fn path(dir: &Path) -> PathBuf {
    dir.join("pr").join("search.json")
}

/// Where `query`'s read is kept: as itself, or beside the one account the Pull Requests page read it as [D243].
pub fn kept_key(query: &str, account: Option<&str>) -> String {
    account.map_or_else(|| query.to_string(), |login| format!("{query}\t{login}"))
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
        // The Code Review page's: no repository, every row named whole [D159].
        let page = Repo {
            kind: Kind::GitHub,
            host: String::new(),
            path: String::new(),
        };
        let (read, home) = match self.repo.as_ref().filter(|r| r.kind == Kind::GitHub) {
            _ if self.id == super::REVIEW => (self.search_accounts(queries, after), page),
            Some(repo) if self.scope.len() > 1 => {
                (self.search_hosts(repo, queries, after), repo.at(""))
            }
            Some(repo) => (self.search_hosts(repo, queries, after), repo.clone()),
            None => return err("Only GitHub's pull requests can be searched."),
        };
        let one = self.one();
        let _held = one.lock().unwrap_or_else(|e| e.into_inner());
        let reader = self.account.as_deref().filter(|_| self.id == super::REVIEW);
        let keys: Vec<String> = queries.iter().map(|q| kept_key(q, reader)).collect();
        let found: Vec<Value> = (keys.iter().enumerate())
            .map(|(i, query)| {
                let was = kept_search(&self.dir, query);
                match &read {
                    Ok((data, partial)) => {
                        let list = &data[format!("l{i}")];
                        let page = (list["nodes"].as_array().into_iter().flatten())
                            .filter(|p| p["number"].is_u64())
                            .map(|p| mark(row(p), &home));
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
            .filter(|q| !keys.iter().any(|n| q["query"] == *n))
            .cloned();
        let kept: Vec<Value> = found.iter().cloned().chain(older).take(KEPT).collect();
        keep(&path(&self.dir), &json!({"queries": kept}));
        Ok(found)
    }

    /// The existing single-server search, with that server's account [D631, D792].
    fn search_host(
        &self,
        repos: &[&Repo],
        queries: &[&str],
        after: Option<&str>,
        many_hosts: bool,
    ) -> Result<(Value, Option<String>), String> {
        let repo = repos[0];
        let gh = gh(repo, self.pick(repo)).ok_or_else(|| super::no_gh(repo, self.pick(repo)))?;
        let repos: Vec<String> = repos.iter().map(|r| format!("repo:{}", r.path)).collect();
        let scope = format!("{} is:pr", repos.join(" "));
        self.search_as(&gh, repo, &scope, queries, after, many_hosts)
    }

    /// Every query in one GraphQL read as `gh`, each under `scope`.
    fn search_as(
        &self,
        gh: &Gh,
        repo: &Repo,
        scope: &str,
        queries: &[&str],
        after: Option<&str>,
        many_hosts: bool,
    ) -> Result<(Value, Option<String>), String> {
        let from = after
            .map(|a| format!(", after: {}", json!(a)))
            .unwrap_or_default();
        let (mut vars, mut declared, mut asks) = (Vec::new(), Vec::new(), String::new());
        let cursors = if many_hosts { "edges { cursor }" } else { "" };
        for (i, query) in queries.iter().enumerate() {
            let sort = if query.contains("sort:") {
                ""
            } else {
                " sort:updated-desc"
            };
            vars.push((format!("q{i}"), format!("{scope} {query}{sort}")));
            declared.push(format!("$q{i}: String!"));
            asks.push_str(&format!(" l{i}: search(query: $q{i}, type: ISSUE, first: {PAGE}{from}) {{ pageInfo {{ endCursor hasNextPage }} {cursors} nodes {{ ...R }} }}"));
        }
        let counts = if many_hosts {
            "comments { totalCount } reactions { totalCount } reactionGroups { content users { totalCount } }"
        } else {
            ""
        };
        let ask = format!(
            "query({}) {{{asks} }} fragment R on PullRequest {{ {ROW} {counts} }}",
            declared.join(", ")
        );
        let pairs: Vec<(&str, &str)> = vars.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let read = graphql(gh, repo, &ask, &pairs);
        if let Ok((data, _)) = &read {
            super::avatars::keep(&self.avatars, data);
        }
        read
    }

    fn search_hosts(
        &self,
        repo: &Repo,
        queries: &[&str],
        after: Option<&str>,
    ) -> Result<(Value, Option<String>), String> {
        let mut hosts: BTreeMap<&str, Vec<&Repo>> = BTreeMap::new();
        for repo in self
            .scope
            .iter()
            .chain(self.scope.is_empty().then_some(repo))
        {
            hosts.entry(&repo.host).or_default().push(repo);
        }
        let keys: Vec<String> = hosts.keys().map(|h| h.to_string()).collect();
        let read = |host: &str, cursor: Option<&str>, many: bool| {
            self.search_host(&hosts[host], queries, cursor, many)
        };
        each(&keys, read, queries, after)
    }

    /// The Code Review page's search [D159]: github.com with no repository scope, as every
    /// account gh keeps there (each by its own token, so `@me` is each one), their rows merged; with
    /// none whose token gh gives, gh as it runs.
    fn search_accounts(
        &self,
        queries: &[&str],
        after: Option<&str>,
    ) -> Result<(Value, Option<String>), String> {
        const HOST: &str = "github.com";
        let path = setup::find("gh", &[]).ok_or(NO_GH)?;
        let path = path.to_string_lossy().into_owned();
        let mut ghs: BTreeMap<String, Gh> = (accounts::logins(&accounts::GH, HOST).into_iter())
            // The page's Account menu reads as one of them alone [D243].
            .filter(|login| self.account.as_ref().is_none_or(|one| one == login))
            .filter_map(|login| {
                let token = Some(token(&path, HOST, &login)?);
                Some((
                    login,
                    Gh {
                        path: path.clone(),
                        token,
                    },
                ))
            })
            .collect();
        if let (true, Some(one)) = (ghs.is_empty(), &self.account) {
            return Err(format!("gh has no token for {one}."));
        }
        if ghs.is_empty() {
            ghs.insert(String::new(), Gh { path, token: None });
        }
        let home = Repo {
            kind: Kind::GitHub,
            host: HOST.into(),
            path: String::new(),
        };
        let keys: Vec<String> = ghs.keys().cloned().collect();
        let read = |login: &str, cursor: Option<&str>, many: bool| {
            self.search_as(&ghs[login], &home, "is:pr", queries, cursor, many)
        };
        each(&keys, read, queries, after)
    }
}

/// Reads each source (a server, or an account) and merges their pages, one source's place in
/// each a cursor of the map `after` names [D792]; one source is read as is.
fn each(
    keys: &[String],
    read: impl Fn(&str, Option<&str>, bool) -> Result<(Value, Option<String>), String>,
    queries: &[&str],
    after: Option<&str>,
) -> Result<(Value, Option<String>), String> {
    {
        if let [one] = keys {
            return read(one, after, false);
        }
        let cursors: Value = after
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| "Refresh pull requests to search every host.".to_string())?
            .unwrap_or_else(|| {
                keys.iter()
                    .map(|host| (host.clone(), Value::Null))
                    .collect()
            });
        if !cursors.as_object().is_some_and(|map| {
            !map.is_empty()
                && map.iter().all(|(host, cursor)| {
                    keys.contains(host) && (cursor.is_null() || cursor.is_string())
                })
        }) {
            return Err("Refresh pull requests to search every host.".into());
        }
        let mut reads = Vec::new();
        for host in keys {
            let Some(cursor) = cursors.get(host) else {
                continue;
            };
            reads.push((host.as_str(), read(host, cursor.as_str(), true)));
        }
        // Keep the previous complete page on failure; never advance another host past missing rows.
        let mut data = json!({});
        let mut errors = Vec::new();
        for (i, query) in queries.iter().enumerate() {
            let mut lists = Vec::new();
            for (host, read) in &reads {
                let (read, partial) = read.as_ref().map_err(|why| format!("{host}: {why}"))?;
                if let Some(why) = partial {
                    errors.push(format!("{host}: {why}"));
                }
                lists.push((*host, &read[format!("l{i}")]));
            }
            data[format!("l{i}")] = merge(&lists, query, &cursors);
        }
        errors.sort();
        errors.dedup();
        Ok((data, (!errors.is_empty()).then(|| errors.join("\n"))))
    }
}

/// Merge at most one page, remembering only the last consumed cursor on each host.
fn merge(lists: &[(&str, &Value)], query: &str, cursors: &Value) -> Value {
    let mut rows: Vec<_> = lists
        .iter()
        .flat_map(|(host, list)| {
            list["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .filter(|(_, pr)| pr["number"].is_u64())
                .map(move |(i, pr)| (*host, i, pr, &list["edges"][i]["cursor"]))
        })
        .collect();
    let sort = query
        .split_whitespace()
        .find_map(|word| word.strip_prefix("sort:"))
        .unwrap_or("updated-desc");
    let ascending = sort.ends_with("-asc");
    let by = sort
        .strip_suffix("-asc")
        .or_else(|| sort.strip_suffix("-desc"))
        .unwrap_or(sort);
    rows.sort_by(|a, b| {
        let order = sort_key(a.2, by, a.1).cmp(&sort_key(b.2, by, b.1));
        if ascending { order } else { order.reverse() }
    });
    let mut next = cursors.clone();
    let mut used = BTreeMap::new();
    let mut nodes: Vec<Value> = Vec::new();
    // A PR two accounts both find is one row; its place still moves on in each.
    for (host, _, pr, cursor) in rows {
        if nodes.len() == PAGE as usize {
            break;
        }
        next[host] = cursor.clone();
        *used.entry(host).or_insert(0) += 1;
        if nodes.iter().all(|n| n["url"] != pr["url"]) {
            nodes.push(pr.clone());
        }
    }
    for (host, list) in lists {
        let count = list["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|pr| pr["number"].is_u64())
            .count();
        if used.get(host).copied().unwrap_or(0) == count {
            if list["pageInfo"]["hasNextPage"] == true {
                next[*host] = list["pageInfo"]["endCursor"].clone();
            } else {
                next.as_object_mut().unwrap().remove(*host);
            }
        }
    }
    let more = next.as_object().is_some_and(|n| !n.is_empty());
    json!({"nodes": nodes, "pageInfo": {"hasNextPage": more, "endCursor": more.then(|| next.to_string())}})
}

fn sort_key(pr: &Value, by: &str, rank: usize) -> u64 {
    let comments = pr["comments"]["totalCount"].as_u64().unwrap_or(0);
    let reactions = pr["reactions"]["totalCount"].as_u64().unwrap_or(0);
    match by {
        "created" => pr["createdAt"].as_str().and_then(iso_ms).unwrap_or(0),
        "comments" => comments,
        "reactions" => reactions,
        "interactions" => comments + reactions,
        // shortcut: relevance ranks are local to each server, until GitHub exposes comparable scores.
        "relevance" => u64::MAX - rank as u64,
        by if by.starts_with("reactions-") => {
            let content = match by.trim_start_matches("reactions-") {
                "+1" => "THUMBS_UP",
                "-1" => "THUMBS_DOWN",
                "smile" => "LAUGH",
                "thinking_face" => "CONFUSED",
                "heart" => "HEART",
                "tada" => "HOORAY",
                _ => "",
            };
            pr["reactionGroups"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|g| g["content"] == content)
                .and_then(|g| g["users"]["totalCount"].as_u64())
                .unwrap_or(0)
        }
        _ => pr["updatedAt"].as_str().and_then(iso_ms).unwrap_or(0),
    }
}

/// A found PR's row: its state, title, number, author, size and when it last changed [D613].
fn row(pr: &Value) -> Value {
    // `host/owner/name#n`, as the Code Review page and every write name it [D159].
    let named = (pr["url"].as_str())
        .and_then(|u| u.strip_prefix("https://"))
        .and_then(|u| u.split_once("/pull/"))
        .map(|(repo, n)| format!("{repo}#{n}"));
    json!({"number": pr["number"], "ref": named, "title": pr["title"], "url": pr["url"],
        "state": pr["state"].as_str().map(str::to_lowercase), "draft": pr["isDraft"],
        "head": pr["headRefName"], "base": pr["baseRefName"],
        "checks": pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"].as_str().map(str::to_lowercase),
        "author": pr["author"]["login"], "additions": pr["additions"], "deletions": pr["deletions"],
        "createdAtMs": pr["createdAt"].as_str().and_then(iso_ms),
        "updatedAtMs": pr["updatedAt"].as_str().and_then(iso_ms)})
}
