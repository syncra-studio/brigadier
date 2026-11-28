//! Add project's and onboarding's GitHub: the repositories every signed-in account sees, and a
//! clone through gh as the account that sees it [D168, D202, D625, D631].

use super::{GH_SECS, Kind, Repo, accounts, avatars, err, failed, setup, token, tool};
use crate::git::{self, Checkout, Target};
use crate::projects::Project;
use serde_json::{Value, json};
use std::path::Path;
use std::{io, thread};

pub(super) const HOST: &str = "github.com";
/// Each account's list is every repository it sees, 100 a page [D680].
/// shortcut: stops at 1,000 an account; page on demand if someone sees more.
const PAGES: usize = 10;
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

/// The active account's private commit email, `<id>+<login>@users.noreply.github.com`, as git's
/// identity form suggests it; None without gh or its sign-in.
pub fn noreply() -> Option<String> {
    let mut command = tool(&gh().ok()?);
    let jq = r#""\(.id)+\(.login)@users.noreply.github.com""#;
    command.args(["api", "user", "--jq", jq]);
    let out = setup::run(&mut command, GH_SECS).ok()?;
    let email = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !email.is_empty()).then_some(email)
}

/// The repositories every account gh keeps for github.com sees (owned, collaborating, its
/// organizations'), the last pushed first, each under every account that sees it, the active one
/// first [D202, D625, D680]; owners' pictures kept in `avatars` [D615]. Or `gh: "missing"` /
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
                nodes.extend(found);
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

/// A folder project's checkouts with a remote, read at once, `homes` in order; the repository None
/// on a server that isn't known.
fn remotes(data: &Path, p: &Project) -> Vec<(Checkout, Option<Repo>)> {
    let home = Path::new(&p.folder);
    let mut found: Vec<(Checkout, Option<Repo>)> = thread::scope(|s| {
        let all: Vec<_> = (crate::folder::repos(home).into_iter())
            .map(|r| s.spawn(move || super::pushed(git::at(data, &home.join(r)).ok()?)))
            .collect();
        (all.into_iter())
            .filter_map(|t| t.join().ok().flatten())
            .collect()
    });
    found.sort_by_key(|(_, r)| {
        let on = r.as_ref().filter(|r| r.kind == Kind::GitHub);
        (on.is_none(), on.is_none_or(|r| r.host != HOST))
    });
    found
}

/// A checkout and the repository its branch pushes to, git picking the remote; None with no
/// known host.
pub(super) fn hosted(checkout: Checkout) -> Option<(Checkout, Repo)> {
    let (checkout, repo) = super::pushed(checkout)?;
    Some((checkout, repo?))
}

/// A folder project's checkouts with a known host: GitHub's first, as only its PRs are searched, and
/// github.com's before any other server's.
pub(super) fn homes(data: &Path, p: &Project) -> Vec<(Checkout, Repo)> {
    (remotes(data, p).into_iter())
        .filter_map(|(c, r)| Some((c, r?)))
        .collect()
}

/// The server a folder project's GitHub account is for, as an account is one server's: the picked
/// account's where it has repositories there, else github.com where it has any there, else its
/// first one's.
fn server<'a>(repos: impl Iterator<Item = &'a Repo>, pick: Option<&str>) -> Option<String> {
    let all: Vec<&Repo> = repos.filter(|r| r.kind == Kind::GitHub).collect();
    let held = pick.and_then(|login| {
        let held = |r: &&&Repo| accounts::logins(&accounts::GH, &r.host).contains(&login.into());
        all.iter().find(held)
    });
    held.or(all.first()).map(|r| r.host.clone())
}

/// What a folder project's GitHub account is for.
pub(super) struct Covered {
    /// On its `server`, in the order of `homes`; none when another server there would be sent the
    /// same token.
    pub repos: Vec<(Checkout, Repo)>,
    /// It has GitHub repositories on other servers, which keep gh's own sign-in there.
    pub more: bool,
}

pub(super) fn covered(data: &Path, p: &Project) -> Covered {
    let mut all = remotes(data, p);
    let unknown = all.iter().any(|(_, r)| r.is_none());
    all.retain(|(_, r)| {
        (r.as_ref()).is_some_and(|r| r.kind == Kind::GitHub && super::slug(&r.path))
    });
    let all: Vec<(Checkout, Repo)> = (all.into_iter())
        .filter_map(|(c, r)| Some((c, r?)))
        .collect();
    let here = server(all.iter().map(|(_, r)| r), p.github_account.as_deref());
    let (mut repos, elsewhere): (Vec<_>, Vec<_>) =
        (all.into_iter()).partition(|(_, r)| here.as_ref() == Some(&r.host));
    let key = here.as_deref().map(accounts::token_key);
    // An unknown server can be a GitHub Enterprise one gh isn't signed in to; never one of GH_TOKEN's.
    if (elsewhere.iter()).any(|(_, r)| Some(accounts::token_key(&r.host)) == key)
        || (unknown && key == Some(accounts::ENTERPRISE))
    {
        repos.clear();
    }
    Covered {
        repos,
        more: !elsewhere.is_empty(),
    }
}

/// Project `id`'s picked account for reading `repo` [D631]; none on another server than the one a
/// folder's is for.
pub(super) fn picked(data: &Path, id: &str, repo: Option<&Repo>) -> Option<String> {
    let p = crate::projects::get(data, id).ok()?;
    let pick = p.github_account.as_deref()?;
    let elsewhere = p.kind == crate::folder::KIND
        && repo.is_some_and(|r| {
            let all = homes(data, &p);
            server(all.iter().map(|(_, r)| r), Some(pick)).is_none_or(|host| host != r.host)
        });
    p.github_account.filter(|_| !elsewhere)
}

impl super::Pr {
    /// The account `repo` is read as: the picked one is for its project's own server alone.
    pub(super) fn pick(&self, repo: &Repo) -> Option<&str> {
        let home = self.repo.as_ref();
        (self.account.as_deref()).filter(|_| home.is_none_or(|h| h.host == repo.host))
    }
}

/// A project's repositories on github.com (`owner/name`), as the Pull Requests page's Project menu scopes its search [D243].
/// Read from each checkout's remote, as `pr()` needs a branch and a detached HEAD would read as none.
pub fn project_repos(data: &Path, id: &str) -> Vec<String> {
    let found: Vec<(Checkout, Repo)> = match crate::projects::get(data, id) {
        Ok(p) if p.kind == crate::folder::KIND => homes(data, &p),
        _ => (git::checkout(data, &Target::Project(id)).ok())
            .and_then(hosted)
            .into_iter()
            .collect(),
    };
    (found.into_iter().map(|(_, r)| r))
        .filter(|r| r.kind == Kind::GitHub && r.host == HOST)
        .map(|r| r.path)
        .collect()
}
