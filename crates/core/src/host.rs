//! The one place that knows git hosts [D1030]: which host a remote is, the web page that opens a
//! PR there with no CLI, and GitHub through the user's own gh (PRs, and Add project's clone and
//! list [D202]). Nothing else names a host.

use crate::adapters::setup;
use crate::git::{self, Checkout, Target, push};
use crate::repos::{failed, tool};
use crate::{load, projects};

mod prs;
mod view;
pub use prs::{chip, kept, moved_on, opened};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

/// Proposed: gh gets this long for a look, and a create this long.
const GH_SECS: u64 = 20;
const CREATE_SECS: u64 = 60;
/// Proposed: the GitHub list's length.
const GH_LIMIT: &str = "200";
/// Past this a link drops its prefilled body: hosts refuse very long URLs (GitHub with a 414).
const LINK_MAX: usize = 6000;

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

    fn web(&self) -> String {
        format!("https://{}/{}", self.host, self.path)
    }
}

/// The host of a remote URL (https, ssh or scp-like), or None for a server it can't name.
// shortcut: only the public services are known (proposed); a self-hosted GitLab, Gitea or
// Forgejo reads as unknown and gets Push branch only, until a setting names its kind.
pub fn repo(url: &str) -> Option<Repo> {
    let url = url.trim();
    let (host, path) = match url.split_once("://") {
        Some((_, rest)) => {
            let (authority, path) = rest.split_once('/')?;
            let host = authority.rsplit('@').next()?;
            (host.split(':').next()?, path)
        }
        // user@host:path, git's scp-like form.
        None => {
            let (authority, path) = url.split_once(':')?;
            (authority.rsplit('@').next()?, path)
        }
    };
    let host = host.to_ascii_lowercase();
    let kind = match host.as_str() {
        "github.com" => Kind::GitHub,
        "gitlab.com" => Kind::GitLab,
        "bitbucket.org" => Kind::Bitbucket,
        "gitea.com" => Kind::Gitea,
        "codeberg.org" => Kind::Forgejo,
        _ => return None,
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    (path.contains('/') && !path.split('/').any(|p| p.is_empty() || p == "..")).then(|| Repo {
        kind,
        host,
        path: path.into(),
    })
}

/// URL-encodes `text`; `/` stays when `slash`, for a branch in a path.
fn enc(text: &str, slash: bool) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            b'/' if slash => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The page that opens a PR from `head` into `base`, as each host links it after a push; GitHub's
/// takes the title and body too (its documented query parameters).
pub fn link(repo: &Repo, base: &str, head: &str, title: &str, body: &str) -> String {
    let web = repo.web();
    let (base_p, head_p, base_q, head_q) = (
        enc(base, true),
        enc(head, true),
        enc(base, false),
        enc(head, false),
    );
    match repo.kind {
        Kind::GitHub => {
            let page = format!(
                "{web}/compare/{base_p}...{head_p}?quick_pull=1&title={}",
                enc(title, false)
            );
            let full = format!("{page}&body={}", enc(body, false));
            if full.len() <= LINK_MAX { full } else { page }
        }
        Kind::GitLab => format!(
            "{web}/-/merge_requests/new?merge_request%5Bsource_branch%5D={head_q}&merge_request%5Btarget_branch%5D={base_q}"
        ),
        Kind::Bitbucket => format!("{web}/pull-requests/new?source={head_q}&dest={base_q}"),
        Kind::Gitea | Kind::Forgejo => format!("{web}/compare/{base_p}...{head_p}"),
    }
}

/// The branch's own page on its host, for the quick pick's Open branch on ‹host› [D1021].
pub fn branch_page(repo: &Repo, branch: &str) -> String {
    let (web, branch) = (repo.web(), enc(branch, true));
    match repo.kind {
        Kind::GitHub => format!("{web}/tree/{branch}"),
        Kind::GitLab => format!("{web}/-/tree/{branch}"),
        Kind::Bitbucket => format!("{web}/branch/{branch}"),
        Kind::Gitea | Kind::Forgejo => format!("{web}/src/branch/{branch}"),
    }
}

/// gh, when it's installed and its active account for `repo`'s server is signed in. Only GitHub
/// has a CLI here yet; GitLab's glab is a later slice [D1030].
fn gh(repo: &Repo) -> Option<String> {
    if repo.kind != Kind::GitHub {
        return None;
    }
    let gh = setup::find("gh", &[])?.to_str()?.to_string();
    let mut command = tool(&gh);
    command.args(["auth", "status", "--active", "--hostname", &repo.host]);
    let out = setup::run(&mut command, GH_SECS).ok()?;
    out.status.success().then_some(gh)
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
    /// The project is trusted, so its own git hooks run on a push [D166, D211].
    trusted: bool,
    record: Option<std::path::PathBuf>,
    /// The session's own folder, where its PRs are kept (`prs.json`).
    dir: std::path::PathBuf,
}

/// The session's PR facts, from Rust's records and git, never from the client.
pub fn pr(data: &Path, id: &str) -> io::Result<Pr> {
    let checkout = git::checkout(data, &Target::Session(id))?;
    // A "here" fork's is its folder's holder's [D1082]; only its owner may land (`share::lands`).
    let Some(base) = crate::share::base(data, &crate::load(data, id)?) else {
        return err("This session has no base to open a PR into.");
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
    let trusted = (load(data, id)?.project)
        .is_some_and(|p| projects::get(data, &p).is_ok_and(|p| p.trusted == Some(true)));
    Ok(Pr {
        id: id.to_string(),
        checkout,
        branch,
        remote,
        base_ref: base,
        base: host_base,
        repo,
        trusted,
        record: crate::share::holder(data, &load(data, id)?).map(|s| s.dir),
        dir: crate::session_dir(data, id),
    })
}

impl Pr {
    /// What the UI needs before Create PR: the host's name, whether its CLI can make the PR, the
    /// branch's PRs (null when gh can't say), the base, and the text to start from.
    pub fn info(&self) -> io::Result<Value> {
        let (title, body) = self.text()?;
        let gh = self.repo.as_ref().and_then(gh);
        Ok(json!({
            "host": self.repo.as_ref().map(Repo::name),
            "cli": gh.is_some(),
            "prs": gh.and_then(|gh| self.prs(&gh)),
            "base": self.base,
            "branch": self.branch,
            "title": title,
            "body": body,
        }))
    }

    /// The PR's first text.
    // shortcut (proposed): from the branch's commits, as `gh pr create --fill` writes it, until
    // 2.19's writer replaces this one function [D1029].
    fn text(&self) -> io::Result<(String, String)> {
        let range = format!("{}..HEAD", self.base_ref);
        let out = git::read(
            &self.checkout.root,
            &["log", "--reverse", "--format=%s%x00%b%x00", &range, "--"],
            &AtomicBool::new(false),
        )?;
        let text = String::from_utf8_lossy(&out);
        let parts: Vec<&str> = text.split('\0').map(str::trim).collect();
        let commits: Vec<(&str, &str)> = parts
            .chunks(2)
            .filter(|c| c.len() == 2 && !c[0].is_empty())
            .map(|c| (c[0], c[1]))
            .collect();
        Ok(match &commits[..] {
            [] => (String::new(), String::new()),
            [(subject, body)] => (subject.to_string(), body.to_string()),
            [(first, _), ..] => {
                let list: Vec<String> = commits.iter().map(|(s, _)| format!("- {s}")).collect();
                (first.to_string(), list.join("\n"))
            }
        })
    }

    pub fn push(&self) -> io::Result<()> {
        push::push(
            &self.checkout,
            &self.remote,
            &self.branch,
            self.trusted,
            &AtomicBool::new(false),
        )
    }

    /// Pushes, then the host's new-PR page for the branch.
    pub fn link(&self, title: &str, body: &str) -> io::Result<String> {
        let Some(repo) = &self.repo else {
            return err("This remote's host isn't one Brigadier knows.");
        };
        self.push()?;
        Ok(link(repo, &self.base, &self.branch, title, body))
    }

    /// Pushes, then makes the PR through the user's own gh and returns its number and URL. If the
    /// branch already has an open PR into the base, that one comes back instead.
    pub fn create(&self, title: &str, body: &str, draft: bool) -> io::Result<Value> {
        let Some((repo, gh)) = self.repo.as_ref().and_then(|r| Some((r, gh(r)?))) else {
            return err("gh isn't installed or signed in here.");
        };
        if title.trim().is_empty() {
            return err("Give the PR a title.");
        }
        self.push()?;
        let mut command = tool(&gh);
        command
            .env("GH_PROMPT_DISABLED", "1")
            .current_dir(&self.checkout.root)
            .args([
                "pr",
                "create",
                &format!("--repo={}/{}", repo.host, repo.path),
                &format!("--head={}", self.branch),
                &format!("--base={}", self.base),
                &format!("--title={title}"),
                &format!("--body={body}"),
            ]);
        if draft {
            command.arg("--draft");
        }
        let out = setup::run(&mut command, CREATE_SECS).map_err(io::Error::other)?;
        let said = format!(
            "{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        let url =
            (said.split_whitespace()).find(|w| w.starts_with("https://") && w.contains("/pull/"));
        match (out.status.success(), url) {
            (_, Some(url)) => Ok(self.made(url)),
            (false, None) => err(failed(&out)),
            (true, None) => err("gh made no PR it could name."),
        }
    }

    /// A PR made or found for the branch, as the UI gets it: its number, read from its URL, and
    /// the URL. Noted as the branch's open PR at once, so the step's next read has it.
    fn made(&self, url: &str) -> Value {
        let number = url.rsplit('/').next().and_then(|n| n.parse::<u64>().ok());
        if number.is_some() {
            note_open(&self.id, &self.branch, number);
            // `prs.json` touched, so the app's watch reads the branch at once, made from a shell too.
            let kept = fs::File::options()
                .append(true)
                .create(true)
                .open(self.dir.join("prs.json"));
            let _ = kept.and_then(|f| f.set_modified(std::time::SystemTime::now()));
        }
        json!({"number": number, "url": url})
    }
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
