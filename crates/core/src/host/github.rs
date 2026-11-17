//! Add project's and onboarding's GitHub: the repositories every signed-in account sees, and a
//! clone through gh as the account that sees it [D168, D202, D625, D631].

use super::{GH_SECS, accounts, avatars, err, failed, setup, token, tool};
use serde_json::{Value, json};
use std::path::Path;
use std::{io, thread};

const HOST: &str = "github.com";
/// Proposed: each account's list is its 200 repositories pushed to last, 100 a page.
const PAGES: usize = 2;
const QUERY: &str = "query($after: String) { viewer { login repositories(first: 100, after: $after, \
    orderBy: {field: PUSHED_AT, direction: DESC}, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], \
    ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) { nodes { nameWithOwner description \
    isPrivate pushedAt owner { login avatarUrl } } pageInfo { hasNextPage endCursor } } } }";

fn gh() -> io::Result<String> {
    let gh = setup::find("gh", &[])
        .ok_or_else(|| io::Error::other("The GitHub CLI (gh) isn't installed."))?;
    Ok(gh.to_string_lossy().into_owned())
}

/// Clones GitHub's `owner/name` into `dir` through gh [D168, D202]: as `account` over https, its
/// token only in gh's environment (an ssh key can't pick an account) [D631]; with none, gh's
/// active account and protocol. It never asks for a password.
pub fn clone_github(from: &str, dir: &Path, secs: u64, account: Option<&str>) -> io::Result<()> {
    let gh = gh()?;
    let mut command = tool(&gh);
    match account {
        Some(user) => {
            let plain = |s: &str| {
                !s.is_empty()
                    && s.chars()
                        .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
            };
            if !from
                .split_once('/')
                .is_some_and(|(o, n)| plain(o) && plain(n))
            {
                return err(format!("{from} isn't a GitHub owner/name"));
            }
            let token = token(&gh, HOST, user)
                .ok_or_else(|| io::Error::other(format!("gh has no sign-in for @{user}.")))?;
            command.env("GH_TOKEN", token);
            command.args(["repo", "clone", &format!("https://{HOST}/{from}.git")]);
        }
        None => _ = command.args(["repo", "clone", from]),
    }
    command.arg(dir).args(["--", "--quiet"]);
    let out = setup::run(&mut command, secs).map_err(io::Error::other)?;
    match out.status.success() {
        true => Ok(()),
        false => err(failed(&out)),
    }
}

/// The repositories every account gh keeps for github.com sees (owned, collaborating, its
/// organizations'), the last pushed first, each once under the first account that sees it, the
/// active one first [D202, D625]; owners' pictures kept in `avatars` [D615]. Or `gh: "missing"` /
/// `"signed-out"`.
pub fn github_repos(avatars: &Path) -> io::Result<Value> {
    let Ok(gh) = gh() else {
        return Ok(json!({"gh": "missing"}));
    };
    let logins = accounts::logins(&accounts::GH, HOST);
    // Each account by its own token, so a GH_TOKEN the daemon inherited never stands in for one; with none
    // in gh's file, gh as it runs.
    let reads: Vec<io::Result<Option<Vec<Value>>>> = thread::scope(|s| {
        let all: Vec<_> = (0..logins.len().max(1))
            .map(|i| {
                let (gh, user) = (&gh, logins.get(i));
                s.spawn(move || match user.map(|u| token(gh, HOST, u)) {
                    Some(None) => Ok(None),
                    Some(token) => list(gh, token),
                    None => list(gh, None),
                })
            })
            .collect();
        (all.into_iter())
            .map(|t| t.join().unwrap_or_else(|_| err("gh's list stopped")))
            .collect()
    });
    let mut nodes: Vec<Value> = vec![];
    let (mut any, mut first_err) = (false, None);
    for read in reads {
        match read {
            Ok(Some(found)) => {
                any = true;
                for node in found {
                    let name = &node["nameWithOwner"];
                    if !nodes.iter().any(|n| &n["nameWithOwner"] == name) {
                        nodes.push(node);
                    }
                }
            }
            Ok(None) => {}
            Err(e) => _ = first_err.get_or_insert(e),
        }
    }
    match (any, first_err) {
        (false, Some(e)) => return Err(e),
        (false, None) => return Ok(json!({"gh": "signed-out"})),
        _ => {}
    }
    // ISO times sort as text; stable, so each account's own order holds among equals.
    nodes.sort_by(|a, b| b["pushedAt"].as_str().cmp(&a["pushedAt"].as_str()));
    let all = Value::Array(nodes);
    avatars::keep(avatars, &all);
    let repos: Vec<Value> = (all.as_array().into_iter().flatten())
        .map(|r| json!({"name": r["nameWithOwner"], "description": r["description"].as_str().filter(|d| !d.is_empty()),
            "private": r["isPrivate"], "account": r["account"]}))
        .collect();
    Ok(json!({"repos": repos}))
}

/// One account's repositories, each with its `account`; None when gh needs a sign-in.
fn list(gh: &str, token: Option<String>) -> io::Result<Option<Vec<Value>>> {
    let (mut found, mut after) = (vec![], None::<String>);
    for _ in 0..PAGES {
        let mut command = tool(gh);
        if let Some(token) = &token {
            command.env("GH_TOKEN", token);
        }
        command.args([
            "api",
            "graphql",
            "--hostname",
            HOST,
            "-f",
            &format!("query={QUERY}"),
        ]);
        match &after {
            Some(cursor) => command.args(["-f", &format!("after={cursor}")]),
            None => command.args(["-F", "after=null"]),
        };
        let out = setup::run(&mut command, GH_SECS).map_err(io::Error::other)?;
        // gh exits 4 when it needs a sign-in (its `gh help exit-codes`); a token GitHub refuses
        // fails with its own hint to sign in again.
        let refused = String::from_utf8_lossy(&out.stderr).contains("gh auth login");
        if out.status.code() == Some(4) || (!out.status.success() && refused) {
            return Ok(None);
        }
        if !out.status.success() {
            return err(failed(&out));
        }
        let body: Value = serde_json::from_slice(&out.stdout)?;
        let viewer = &body["data"]["viewer"];
        let page = &viewer["repositories"];
        for node in page["nodes"].as_array().into_iter().flatten() {
            let mut node = node.clone();
            node["account"] = viewer["login"].clone();
            found.push(node);
        }
        after = page["pageInfo"]["endCursor"].as_str().map(String::from);
        if page["pageInfo"]["hasNextPage"] != true || after.is_none() {
            break;
        }
    }
    Ok(Some(found))
}
