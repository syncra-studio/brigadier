//! The one place that knows git hosts [D1030]: which host a remote is, the web page that opens a
//! PR there with no CLI, and GitHub through the user's own gh (PRs, and Add project's clone and
//! list [D202]). Nothing else names a host.

use crate::adapters::setup;
use crate::git::{self, Checkout, Target, push};
use crate::load;
use crate::repos::{failed, tool};

pub mod accounts;
mod actions;
mod avatars;
mod chat;
mod chip;
mod create;
mod github;
mod prs;
mod review;
mod search;
mod timeline;
mod touched;
mod view;
mod write;
use accounts::no_gh;
pub use actions::{kept_run, kept_runs};
pub use chat::{chat, listed};
pub use chip::{chip, moved_on, opened};
pub use create::Create;
use github::hosted;
pub use github::{clone_github, github_repos, noreply, project_repos};
pub use prs::kept;
pub use search::{kept_key, kept_search};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
pub use view::{kept_files, kept_view, tabbed};
pub use write::{REVIEW, Verdict, named, qualified};

/// Proposed: gh gets this long for a look, and a create this long.
const GH_SECS: u64 = 20;
/// Why a host read couldn't start.
const NO_GH: &str = "gh isn't installed, or signed in to an account that can read this repository.";

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
    /// The repository's page on its own server.
    fn url(&self) -> String {
        format!("https://{}/{}", self.host, self.path)
    }

    /// Its key in `READER`.
    fn key(&self) -> String {
        format!("{}/{}", self.host, self.path)
    }

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

/// The project whose repository is `owner/name` (its `origin`), for a PR's review chat [D198]; None
/// when none is.
pub fn project_of(data: &Path, path: &str) -> Option<String> {
    let projects = crate::projects::list(data).ok()?;
    projects.into_iter().find_map(|p| {
        let checkout = git::checkout(data, &Target::Project(&p.id)).ok()?;
        let url = push::url(&checkout, "origin").ok()?;
        repo(&url)
            .is_some_and(|r| r.path.eq_ignore_ascii_case(path))
            .then_some(p.id)
    })
}

/// A PR tab's target [D213]: `n` for the session's own repository's PR `n`, `owner/name#n` for
/// another's on the same server, or `host/owner/name#n` across servers [D792].
pub fn pr_ref(target: &str) -> Option<(Option<String>, u64)> {
    let (repo, n) = match target.rsplit_once('#') {
        Some((repo, n)) => (Some(repo), n),
        None => (None, target),
    };
    if repo.is_some_and(|r| !slug(r) && !hosted_slug(r)) {
        return None;
    }
    let number: u64 = n.parse().ok()?;
    (number.to_string() == n).then(|| (repo.map(String::from), number))
}

/// A cross-host PR target includes its server, keeping identical owner/name paths distinct.
fn hosted_slug(path: &str) -> bool {
    path.split_once('/').is_some_and(|(host, path)| {
        host.split('.').all(|label| {
            !label.is_empty() && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        }) && slug(path)
    })
}

/// The host of a remote URL (https, ssh or scp-like), or None for a server it can't name.
// shortcut: public services and GitHub servers signed in through gh are known; a self-hosted GitLab, Gitea or
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
        // GitHub's own domain, signed in or not.
        _ if host.ends_with(".ghe.com") => Some(Kind::GitHub),
        _ if !accounts::logins(&accounts::GH, host).is_empty() => Some(Kind::GitHub),
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
            command
                .env("GH_TOKEN", token)
                .env("GH_ENTERPRISE_TOKEN", token);
        }
        command
    }
}

/// Which account last read each repository (`host/path`; None is the active one), tried first.
static READER: Mutex<BTreeMap<String, Option<String>>> = Mutex::new(BTreeMap::new());

/// gh as an account that can read `repo`: the project's pick, held unprobed [D631], the one that last did (unprobed, a gh call saved on
/// every read [D200]; a read it fails forgets it), the active one, else each other account signed
/// in for its server [D175]. Only GitHub has a CLI here yet; GitLab's glab is a
/// later slice [D1030].
fn gh(repo: &Repo, pick: Option<&str>) -> Option<Gh> {
    if repo.kind != Kind::GitHub {
        return None;
    }
    let path = setup::find("gh", &[])?.to_str()?.to_string();
    let key = repo.key();
    let last = READER.lock().unwrap().get(&key).cloned();
    let pick = pick.map(|login| Some(login.to_string()));
    let others = std::iter::once_with(|| others(&repo.host)).flatten();
    let mut tried = Vec::new();
    for user in (pick.clone().into_iter())
        .chain(last.clone())
        .chain([None])
        .chain(others.map(Some))
    {
        if tried.contains(&user) {
            continue;
        }
        tried.push(user.clone());
        let token = match &user {
            Some(login) => match token(&path, &repo.host, login) {
                Some(token) => Some(token),
                // A picked account gh can't give a token for fails, never read as another [D631].
                None if pick.as_ref() == Some(&user) => return None,
                None => continue,
            },
            None => None,
        };
        let gh = Gh {
            path: path.clone(),
            token,
        };
        if last.as_ref() == Some(&user) || pick.as_ref() == Some(&user) {
            return Some(gh);
        }
        if reads(&gh, repo) == Some(true) {
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

/// Whether `gh` can read `repo`; None when GitHub couldn't be asked.
fn reads(gh: &Gh, repo: &Repo) -> Option<bool> {
    let mut probe = gh.command();
    let path = format!("repos/{}", repo.path);
    probe.args(["api", "--hostname", &repo.host, "--silent", &path]);
    let out = setup::run(&mut probe, GH_SECS).ok()?;
    let said = String::from_utf8_lossy(&out.stderr);
    let refused = ["(HTTP 401)", "(HTTP 403)", "(HTTP 404)"];
    let no = refused.iter().any(|c| said.contains(c)) && !said.contains("rate limit");
    (out.status.success() || no).then_some(out.status.success())
}

/// `repo`'s reader failed a read: the next one probes again.
fn forget(repo: &Repo) {
    READER.lock().unwrap().remove(&repo.key());
}

/// The accounts gh has signed in for `host` other than its active one, which it lists first.
fn others(host: &str) -> Vec<String> {
    accounts::logins(&accounts::GH, host)
        .into_iter()
        .skip(1)
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
    /// A folder project's GitHub repositories, searched once per server [D780, D792].
    scope: Vec<Repo>,
    record: Option<std::path::PathBuf>,
    /// The session's own folder, where its PRs are kept (`prs.json`).
    dir: std::path::PathBuf,
    /// Where the pictures of the people its reads name are kept [D615].
    avatars: std::path::PathBuf,
    /// Its project's GitHub account, read as [D631]; None: whichever can see the repository. On the
    /// Pull Requests page, the one account its search reads as, else every one [D243].
    pub account: Option<String>,
    /// Its project's id, whose folder keeps the default branch GitHub named [D168].
    project: Option<String>,
}

/// `hosted`, the repository None on a server it can't name; None with no remote.
fn pushed(checkout: Checkout) -> Option<(Checkout, Option<Repo>)> {
    let never = AtomicBool::new(false);
    let head = git::read(
        &checkout.root,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        &never,
    );
    let branch = head.map(|out| String::from_utf8_lossy(&out).trim().to_string());
    let remote = push::remote(&checkout, &branch.unwrap_or_default()).ok()?;
    let repo = repo(&push::url(&checkout, &remote).ok()?);
    Some((checkout, repo))
}

/// Where `id`'s reads are kept: a session's folder, or a project's, whose tabs read its repository
/// before a session there starts and which goes with the project [D279].
pub fn dir(data: &Path, id: &str) -> std::path::PathBuf {
    match Target::session(id) {
        // `@` alone is the Code Review page, never a session's repository (`<id>@<repo>`).
        _ if id == REVIEW => data.join("review"),
        // A claimed repo's are kept beside its record [D494]; one never claimed has none.
        Target::Repo(sid, repo) => crate::folder::record_of(data, sid, repo)
            .unwrap_or_else(|_| crate::session_dir(data, sid).join("repos")),
        _ if crate::projects::get(data, id).is_ok() => crate::projects::dir(data, id),
        _ => crate::session_dir(data, id),
    }
}

/// The session's PR facts, from Rust's records and git, never from the client. A project's are
/// its main checkout's, with no base and nothing it lands [D279].
pub fn pr(data: &Path, id: &str) -> io::Result<Pr> {
    if id == REVIEW {
        return Ok(write::page(data));
    }
    let project = crate::projects::get(data, id).is_ok();
    let target = match project {
        true => Target::Project(id),
        false => Target::session(id),
    };
    // A folder project reads through its first repository and searches them all [D780].
    let folder = (crate::projects::get(data, id).ok()).filter(|p| p.kind == crate::folder::KIND);
    let homes: Vec<(Checkout, Repo)> = (folder.iter())
        .flat_map(|p| github::homes(data, p))
        .collect();
    let checkout = match homes.first() {
        Some((first, _)) => first.clone(),
        None => git::checkout(data, &target)?,
    };
    // An "Existing worktree" session's is its folder's holder's. A Local session has none: its
    // PRs are still read.
    let base = match target {
        Target::Project(_) => String::new(),
        Target::Repo(..) => git::base_of(data, &target).unwrap_or_default(),
        Target::Session(id) => {
            crate::share::base(data, &crate::load(data, id)?).unwrap_or_default()
        }
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
    let project = match target {
        Target::Project(id) => Some(id.to_string()),
        Target::Session(id) | Target::Repo(id, _) => load(data, id).ok().and_then(|s| s.project),
    };
    let account = (project.as_ref()).and_then(|p| github::picked(data, p, repo.as_ref()));
    let scope = (homes.into_iter().map(|(_, r)| r))
        .filter(|r| r.kind == Kind::GitHub && slug(&r.path))
        .collect();
    Ok(Pr {
        id: id.to_string(),
        checkout,
        branch,
        remote,
        base_ref: base,
        base: host_base,
        repo,
        scope,
        record: match target {
            Target::Project(_) => None,
            Target::Repo(sid, repo) => Some(crate::folder::record_of(data, sid, repo)?),
            Target::Session(id) => crate::share::holder(data, &load(data, id)?).map(|s| s.dir),
        },
        dir: dir(data, id),
        avatars: data.join("avatars"),
        account,
        project,
    })
}
