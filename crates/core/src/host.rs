//! The one place that knows git hosts [D1030]: which host a remote is, the web page that opens a
//! PR there with no CLI, and GitHub through the user's own gh (PRs, and Add project's clone and
//! list [D202]). Nothing else names a host.

use crate::adapters::setup;
use crate::git::{self, Checkout, Target, push};
use crate::load;
use crate::repos::{failed, tool};

mod actions;
mod chip;
mod prs;
mod review;
mod search;
mod timeline;
mod touched;
mod view;
pub use actions::{kept_run, kept_runs};
pub use chip::{chip, moved_on, opened};
pub use prs::kept;
pub use search::kept_search;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
pub use view::{kept_files, kept_view, tabbed};

/// A row's mark with its PRs' `chip` [D261]: a PR it shows failing its checks needs the user
/// (amber), under a question or a turn at work.
pub fn marked(mark: Option<&'static str>, chip: &Value) -> Option<&'static str> {
    match mark {
        Some("working" | "needs") => mark,
        _ if chip["chip"] == "checks_failed" => Some("amber"),
        _ => mark,
    }
}

/// Proposed: gh gets this long for a look, and a create this long.
const GH_SECS: u64 = 20;
/// Why a host read couldn't start.
const NO_GH: &str = "gh isn't installed, or signed in to an account that can read this repository.";
/// Proposed: the GitHub list's length.
const GH_LIMIT: &str = "200";

fn err<T>(message: impl Into<String>) -> io::Result<T> {
    Err(io::Error::other(message.into()))
}

/// Each session branch's open PR as its last PR read found it: info's list, a view and a merge.
/// Keyed by branch too, so a renamed or switched branch never takes the old one's PR.
static OPEN: Mutex<BTreeMap<(String, String), u64>> = Mutex::new(BTreeMap::new());

/// The session branch's open PR, as the host was last read in this process; None before any read.
pub fn open_pr(id: &str, branch: &str) -> Option<u64> {
    OPEN.lock()
        .unwrap()
        .get(&(id.into(), branch.into()))
        .copied()
}

fn note_open(id: &str, branch: &str, number: Option<u64>) {
    let mut open = OPEN.lock().unwrap();
    let key = (id.to_string(), branch.to_string());
    match number {
        Some(n) => open.insert(key, n),
        None => open.remove(&key),
    };
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    GitHub,
    GitLab,
    Bitbucket,
    Gitea,
    Forgejo,
}

/// A repository on a known host: its kind, server and `owner/name` path.
#[derive(Clone, PartialEq, Debug)]
pub struct Repo {
    kind: Kind,
    host: String,
    path: String,
}

impl Repo {
    /// The host's own name, for the UI to show.
    pub fn name(&self) -> &'static str {
        match self.kind {
            Kind::GitHub => "GitHub",
            Kind::GitLab => "GitLab",
            Kind::Bitbucket => "Bitbucket",
            Kind::Gitea => "Gitea",
            Kind::Forgejo => "Forgejo",
        }
    }

    /// Another repository on the same server, `owner/name` [D213].
    fn at(&self, path: &str) -> Repo {
        Repo {
            path: path.to_string(),
            ..self.clone()
        }
    }
}

/// A repository's `owner/name` as GitHub allows it, so it can go into a query or a path as is.
fn slug(path: &str) -> bool {
    let ok = |s: &str| {
        !s.is_empty()
            && !s.starts_with('.')
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    };
    path.split_once('/').is_some_and(|(o, n)| ok(o) && ok(n))
}

/// A PR tab's target [D213]: `n` for the session's own repository's PR `n`, `owner/name#n` for
/// another's on the same server.
pub fn pr_ref(target: &str) -> Option<(Option<String>, u64)> {
    let (repo, n) = match target.rsplit_once('#') {
        Some((repo, n)) => (Some(repo), n),
        None => (None, target),
    };
    if repo.is_some_and(|r| !slug(r)) {
        return None;
    }
    let number: u64 = n.parse().ok()?;
    (number.to_string() == n).then(|| (repo.map(String::from), number))
}

/// The host of a remote URL (https, ssh or scp-like), or None for a server it can't name.
// shortcut: only the public services are known (proposed); a self-hosted GitLab, Gitea or
// Forgejo reads as unknown and gets Push branch only, until a setting names its kind.
pub fn repo(url: &str) -> Option<Repo> {
    let url = url.trim();
    let (host, path, ssh) = match url.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = rest.split_once('/')?;
            let host = authority.rsplit('@').next()?;
            (host.split(':').next()?, path, scheme.contains("ssh"))
        }
        // user@host:path, git's scp-like form.
        None => {
            let (authority, path) = url.split_once(':')?;
            (authority.rsplit('@').next()?, path, true)
        }
    };
    let known = |host: &str| match host {
        "github.com" => Some(Kind::GitHub),
        "gitlab.com" => Some(Kind::GitLab),
        "bitbucket.org" => Some(Kind::Bitbucket),
        "gitea.com" => Some(Kind::Gitea),
        "codeberg.org" => Some(Kind::Forgejo),
        _ => None,
    };
    let mut host = host.to_ascii_lowercase();
    // An ssh host alias (`github.com-work`) is the host its ssh config names, as git's push finds it.
    if ssh
        && known(&host).is_none()
        && let Some(real) = ssh_host(&host)
    {
        host = real;
    }
    let kind = known(&host)?;
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    (path.contains('/') && !path.split('/').any(|p| p.is_empty() || p == "..")).then(|| Repo {
        kind,
        host,
        path: path.into(),
    })
}

/// The host ssh connects to for `alias`, by its own config (`ssh -G`).
fn ssh_host(alias: &str) -> Option<String> {
    let mut command = tool("ssh");
    command.args(["-G", "--", alias]);
    let out = setup::run(&mut command, GH_SECS).ok()?;
    let config = String::from_utf8_lossy(&out.stdout);
    let real = config.lines().find_map(|l| l.strip_prefix("hostname "))?;
    out.status
        .success()
        .then(|| real.trim().to_ascii_lowercase())
}

/// gh as one signed-in account: the active one, or another's token in each child's environment only.
struct Gh {
    path: String,
    token: Option<String>,
}

impl Gh {
    fn command(&self) -> std::process::Command {
        let mut command = tool(&self.path);
        if let Some(token) = &self.token {
            command.env("GH_TOKEN", token);
        }
        command
    }
}

/// Which account last read each repository (`host/path`; None is the active one), tried first.
static READER: Mutex<BTreeMap<String, Option<String>>> = Mutex::new(BTreeMap::new());

/// gh as an account that can read `repo`: the one that last did (unprobed, a gh call saved on
/// every read [D200]; a read it fails forgets it), the active one, else each other account signed
/// in for its server [D175]. Only GitHub has a CLI here yet; GitLab's glab is a
/// later slice [D1030].
fn gh(repo: &Repo) -> Option<Gh> {
    if repo.kind != Kind::GitHub {
        return None;
    }
    let path = setup::find("gh", &[])?.to_str()?.to_string();
    let key = format!("{}/{}", repo.host, repo.path);
    let last = READER.lock().unwrap().get(&key).cloned();
    let others = std::iter::once_with(|| others(&path, &repo.host)).flatten();
    let mut tried = Vec::new();
    for user in last
        .clone()
        .into_iter()
        .chain([None])
        .chain(others.map(Some))
    {
        if tried.contains(&user) {
            continue;
        }
        tried.push(user.clone());
        let token = match &user {
            Some(user) => match token(&path, &repo.host, user) {
                Some(token) => Some(token),
                None => continue,
            },
            None => None,
        };
        let gh = Gh {
            path: path.clone(),
            token,
        };
        if last.as_ref() == Some(&user) {
            return Some(gh);
        }
        let mut probe = gh.command();
        probe.args([
            "api",
            "--hostname",
            &repo.host,
            "--silent",
            &format!("repos/{}", repo.path),
        ]);
        if setup::run(&mut probe, GH_SECS).is_ok_and(|out| out.status.success()) {
            READER.lock().unwrap().insert(key, user);
            return Some(gh);
        }
    }
    None
}

/// One GraphQL read on `repo` through `gh` [D207], `$owner` and `$name` set: its data, and why a part
/// of it couldn't be read; or why none could, the account that read it forgotten so the next one
/// finds one that can.
fn graphql(
    gh: &Gh,
    repo: &Repo,
    query: &str,
    vars: &[(&str, &str)],
) -> Result<(Value, Option<String>), String> {
    let (owner, name) = repo.path.split_once('/').unwrap_or((&repo.path, ""));
    let mut command = gh.command();
    command.args(["api", "graphql", "--hostname", &repo.host]);
    command.args([
        "-f",
        &format!("query={query}"),
        "-f",
        &format!("owner={owner}"),
        "-f",
        &format!("name={name}"),
    ]);
    for (key, value) in vars {
        command.args(["-f", &format!("{key}={value}")]);
    }
    let out = setup::run(&mut command, GH_SECS).map_err(|e| e.to_string())?;
    // gh exits non-zero on any error, printing what was read all the same.
    let body: Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    let why = (body["errors"].as_array().into_iter().flatten())
        .filter_map(|e| e["message"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if body["data"].is_object() {
        return Ok((body["data"].clone(), (!why.is_empty()).then_some(why)));
    }
    forget(repo);
    Err(match why.is_empty() {
        true => failed(&out),
        false => why,
    })
}

/// `repo`'s reader failed a read: the next one probes again.
fn forget(repo: &Repo) {
    READER
        .lock()
        .unwrap()
        .remove(&format!("{}/{}", repo.host, repo.path));
}

/// The accounts gh has signed in for `host` other than its active one.
fn others(gh: &str, host: &str) -> Vec<String> {
    let mut command = tool(gh);
    command.args(["auth", "status", "--hostname", host, "--json", "hosts"]);
    let Ok(out) = setup::run(&mut command, GH_SECS) else {
        return Vec::new();
    };
    let status: Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    (status["hosts"][host].as_array().into_iter().flatten())
        .filter(|a| a["active"] != true && a["state"] == "success")
        .filter_map(|a| a["login"].as_str().map(String::from))
        .collect()
}

/// `user`'s token for `host`, kept by gh; never printed, logged or stored here.
fn token(gh: &str, host: &str, user: &str) -> Option<String> {
    let mut command = tool(gh);
    command.args(["auth", "token", "--hostname", host, "--user", user]);
    let out = setup::run(&mut command, GH_SECS).ok()?;
    let token = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !token.is_empty()).then_some(token)
}

/// What a session's Create PR works from: its checkout, branch, push remote, the base it lands
/// into, and the remote's host if one is known.
pub struct Pr {
    /// The session's id.
    id: String,
    checkout: Checkout,
    pub branch: String,
    pub remote: String,
    /// The base as the session records it (a local or remote-tracking ref), and its name on the host.
    base_ref: String,
    pub base: String,
    pub repo: Option<Repo>,
    record: Option<std::path::PathBuf>,
    /// The session's own folder, where its PRs are kept (`prs.json`).
    dir: std::path::PathBuf,
}

/// Where `id`'s reads are kept: a session's folder, or a project's, whose tabs read its repository
/// before a session there starts and which goes with the project [D279].
pub fn dir(data: &Path, id: &str) -> std::path::PathBuf {
    match crate::projects::get(data, id) {
        Ok(_) => crate::projects::dir(data, id),
        Err(_) => crate::session_dir(data, id),
    }
}

/// The session's PR facts, from Rust's records and git, never from the client. A project's are
/// its main checkout's, with no base and nothing it lands [D279].
pub fn pr(data: &Path, id: &str) -> io::Result<Pr> {
    let project = crate::projects::get(data, id).is_ok();
    let target = match project {
        true => Target::Project(id),
        false => Target::Session(id),
    };
    let checkout = git::checkout(data, &target)?;
    // A "here" fork's is its folder's holder's [D1082]; only its owner may land (`share::lands`).
    // A Local session has none: its PRs are still read, and none of them lands it.
    let base = match project {
        true => String::new(),
        false => crate::share::base(data, &crate::load(data, id)?).unwrap_or_default(),
    };
    let never = AtomicBool::new(false);
    let out = git::read(
        &checkout.root,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        &never,
    )
    .or_else(|_| err("The session isn't on a branch."))?;
    let branch = String::from_utf8_lossy(&out).trim().to_string();
    let remote = push::remote(&checkout, &branch)?;
    // A base taken from a remote branch lands into that branch's name on the host, whichever
    // remote the push goes to.
    let remotes = git::read(&checkout.root, &["remote"], &never)?;
    let host_base = (String::from_utf8_lossy(&remotes).lines())
        .find_map(|r| base.strip_prefix(&format!("{r}/")))
        .unwrap_or(&base)
        .to_string();
    // shortcut: the PR is made in the repository the branch is pushed to; a fork's PR into its
    // upstream (head and base in two repositories) waits until someone needs it.
    let repo = repo(&push::url(&checkout, &remote)?);
    Ok(Pr {
        id: id.to_string(),
        checkout,
        branch,
        remote,
        base_ref: base,
        base: host_base,
        repo,
        record: match project {
            true => None,
            false => crate::share::holder(data, &load(data, id)?).map(|s| s.dir),
        },
        dir: dir(data, id),
    })
}

/// Clones GitHub's `owner/name` into `dir` through gh, with gh's own sign-in and protocol [D168,
/// D202]. It never asks for a password.
pub fn clone_github(from: &str, dir: &Path, secs: u64) -> io::Result<()> {
    let gh = setup::find("gh", &[])
        .ok_or_else(|| io::Error::other("The GitHub CLI (gh) isn't installed."))?;
    let mut command = tool(gh.to_str().unwrap_or("gh"));
    command
        .args(["repo", "clone", from])
        .arg(dir)
        .args(["--", "--quiet"]);
    let out = setup::run(&mut command, secs).map_err(io::Error::other)?;
    match out.status.success() {
        true => Ok(()),
        false => err(failed(&out)),
    }
}

/// Your GitHub repositories through the gh CLI [D202], or `gh: "missing"` / `"signed-out"`.
pub fn github_repos() -> io::Result<Value> {
    let Some(gh) = setup::find("gh", &[]) else {
        return Ok(json!({"gh": "missing"}));
    };
    let fields = "nameWithOwner,description,isPrivate";
    let mut command = tool(gh.to_str().unwrap_or("gh"));
    command.args(["repo", "list", "--json", fields, "--limit", GH_LIMIT]);
    let out = setup::run(&mut command, GH_SECS).map_err(io::Error::other)?;
    // gh exits 4 when it needs a sign-in (its `gh help exit-codes`); a token GitHub refuses fails
    // with its own hint to sign in again.
    let refused = String::from_utf8_lossy(&out.stderr).contains("gh auth login");
    if out.status.code() == Some(4) || (!out.status.success() && refused) {
        return Ok(json!({"gh": "signed-out"}));
    }
    if !out.status.success() {
        return err(failed(&out));
    }
    let list: Vec<Value> = serde_json::from_slice(&out.stdout)?;
    let repos: Vec<Value> = list
        .iter()
        .map(|r| json!({"name": r["nameWithOwner"], "description": r["description"].as_str().filter(|d| !d.is_empty()), "private": r["isPrivate"]}))
        .collect();
    Ok(json!({"repos": repos}))
}
