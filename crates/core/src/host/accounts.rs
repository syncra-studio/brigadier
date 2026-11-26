//! The accounts gh and glab keep signed in, read from their own config files: no network, no
//! keychain, no process [D624, D625, D629]; and a project's GitHub account [D631].

use super::github::{Covered, covered};
use super::{Gh, Kind, Repo, reads, token};
use crate::Spec;
use crate::adapters::{self, setup};
use crate::git::{self, Target, push};
use crate::projects::Project;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Condvar, LazyLock, Mutex};
use std::{env, fs, io, thread};

/// A CLI's config file: under this variable, else this under XDG_CONFIG_HOME, else these under
/// home; its hosts' entries at the top (gh) or under `hosts` (glab).
pub struct Cli {
    dir_var: &'static str,
    xdg: &'static str,
    homes: &'static [&'static str],
    file: &'static str,
    under: &'static [&'static str],
}

pub const GH: Cli = Cli {
    dir_var: "GH_CONFIG_DIR",
    xdg: "gh",
    homes: &[".config/gh"],
    file: "hosts.yml",
    under: &[],
};

pub const GLAB: Cli = Cli {
    dir_var: "GLAB_CONFIG_DIR",
    xdg: "glab-cli",
    homes: &["Library/Application Support/glab-cli", ".config/glab-cli"],
    file: "config.yml",
    under: &["hosts"],
};

/// The logins `cli` keeps for `host`: its active `user` first, then every one under `users`
/// where it keeps several (gh).
pub fn logins(cli: &Cli, host: &str) -> Vec<String> {
    let home = adapters::home_path("");
    let dirs = (env::var_os(cli.dir_var).map(PathBuf::from).into_iter())
        .chain(env::var_os("XDG_CONFIG_HOME").map(|x| Path::new(&x).join(cli.xdg)))
        .chain(cli.homes.iter().map(|h| home.join(h)));
    let file = dirs.map(|d| d.join(cli.file)).find(|p| p.is_file());
    let text = file
        .and_then(|p| fs::read_to_string(p).ok())
        .unwrap_or_default();
    let entry = [cli.under, &[host]].concat();
    let active =
        (children(&text, &entry).into_iter()).filter_map(|(k, v)| (k == "user").then_some(v));
    let users = (children(&text, &[&entry[..], &["users"]].concat()).into_iter()).map(|(k, _)| k);
    let mut all = vec![];
    for login in active.chain(users) {
        if !login.is_empty() && !all.contains(&login) {
            all.push(login);
        }
    }
    all
}

/// The keys and values right under `path` in a YAML file of plain nested maps, as gh and glab write.
fn children(text: &str, path: &[&str]) -> Vec<(String, String)> {
    let plain = |s: &str| s.trim().trim_matches(['"', '\'']).to_string();
    let (mut over, mut out) = (Vec::<(usize, String)>::new(), vec![]);
    for line in text.lines() {
        let entry = line.trim_start();
        let Some((key, value)) = entry.split_once(':') else {
            continue;
        };
        if entry.starts_with(['#', '-']) {
            continue;
        }
        let indent = line.len() - entry.len();
        while over.last().is_some_and(|(i, _)| *i >= indent) {
            over.pop();
        }
        if over
            .iter()
            .map(|(_, k)| k.as_str())
            .eq(path.iter().copied())
        {
            out.push((plain(key), plain(value)));
        }
        over.push((indent, plain(key)));
    }
    out
}

/// The push destination of this checkout's current branch, also when HEAD is detached.
fn destination(checkout: &git::Checkout) -> io::Result<(String, String)> {
    let branch = git::sync::branch(checkout).unwrap_or_default();
    let remote = push::remote(checkout, &branch)?;
    let url = push::url(checkout, &remote)?;
    Ok((remote, url))
}

/// The repository a picked account's token is for, so the child always gets it [D631, C19]: the
/// push destination when it is on GitHub, else the first GitHub remote (with remotes on several
/// GitHub hosts, the first decides), else github.com, since a pick names a login and no host.
/// Only git itself failing is an error.
fn picked_repo(checkout: &git::Checkout) -> io::Result<Repo> {
    let github = |url: &str| super::repo(url).filter(|r| r.kind == Kind::GitHub);
    if let Some(repo) = destination(checkout).ok().and_then(|(_, url)| github(&url)) {
        return Ok(repo);
    }
    for remote in push::remotes(checkout)? {
        if let Some(repo) = push::url(checkout, &remote)
            .ok()
            .and_then(|url| github(&url))
        {
            return Ok(repo);
        }
    }
    Ok(Repo {
        kind: Kind::GitHub,
        host: "github.com".into(),
        path: String::new(),
    })
}

/// Whether `checkout` pushes over SSH, as git rewrites its URL: get-url includes
/// insteadOf/pushInsteadOf, which can turn HTTPS into SSH.
fn ssh(checkout: &git::Checkout) -> bool {
    let Ok((remote, url)) = destination(checkout) else {
        return false;
    };
    let effective = git::read(
        &checkout.root,
        &["remote", "get-url", "--push", &remote],
        &AtomicBool::new(false),
    )
    .ok();
    let effective = effective.as_deref().map(String::from_utf8_lossy);
    let url = effective.as_deref().unwrap_or(&url);
    url.split_once("://")
        .map_or_else(|| url.contains(':'), |(scheme, _)| scheme.contains("ssh"))
}

/// Whether `gh` can read every one of `repos`, asked at once.
fn reads_all(gh: &Gh, repos: &[&Repo]) -> Option<bool> {
    std::thread::scope(|s| {
        let all: Vec<_> = (repos.iter()).map(|r| s.spawn(|| reads(gh, r))).collect();
        let all: Vec<_> = (all.into_iter())
            .map(|read| read.join().ok().flatten())
            .collect();
        match all.contains(&Some(false)) {
            true => Some(false),
            false => all.into_iter().all(|read| read.is_some()).then_some(true),
        }
    })
}

/// Which of `logins` can see every one of `repos`, on one server, None where it couldn't be told
/// (offline); asked at once.
fn sees(repos: &[&Repo], logins: &[String]) -> Vec<Option<bool>> {
    let gh = setup::find("gh", &[]).and_then(|p| Some(p.to_str()?.to_string()));
    thread::scope(|s| {
        let probes = logins.iter().map(|login| {
            let gh = gh.as_deref();
            s.spawn(move || {
                let path = gh?.to_string();
                match token(&path, &repos[0].host, login) {
                    Some(t) => reads_all(
                        &Gh {
                            path,
                            token: Some(t),
                        },
                        repos,
                    ),
                    // A listed login without a token cannot read, even while GitHub is reachable.
                    None => Some(false),
                }
            })
        });
        let probes: Vec<_> = probes.collect();
        (probes.into_iter())
            .map(|p| p.join().ok().flatten())
            .collect()
    })
}

/// GitHub facts for Project settings, also saved so they show at once after a restart.
static SEEN: Mutex<BTreeMap<String, Value>> = Mutex::new(BTreeMap::new());
static PROBING: LazyLock<Mutex<HashSet<(String, String)>>> = LazyLock::new(Mutex::default);
static PROBED: Condvar = Condvar::new();

fn kept_path(data: &Path, id: &str) -> PathBuf {
    crate::projects::dir(data, id).join("github.json")
}

/// `p`'s last GitHub facts, or null before any read of its folder. Publication only uses this cache.
pub fn known(data: &Path, p: &Project) -> Value {
    let mut seen = SEEN.lock().unwrap();
    let facts = seen.entry(p.id.clone()).or_insert_with(|| {
        let kept = fs::read(kept_path(data, &p.id)).ok();
        kept.and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    });
    match facts["folder"] == p.folder {
        true => facts.clone(),
        false => Value::Null,
    }
}

fn keep(data: &Path, p: &Project, facts: &Value) -> io::Result<()> {
    let (_lock, list) = crate::projects::locked(data)?;
    if !list
        .iter()
        .any(|now| now.id == p.id && now.folder == p.folder && !now.removing)
        || known(data, p) == *facts
    {
        return Ok(());
    }
    let path = kept_path(data, &p.id);
    fs::create_dir_all(crate::projects::dir(data, &p.id))?;
    crate::write_atomic(&path, facts.to_string().as_bytes())?;
    SEEN.lock().unwrap().insert(p.id.clone(), facts.clone());
    Ok(())
}

/// `p`'s repositories its GitHub account is for, and its facts with each account's last answer:
/// whether it's on GitHub, and each account signed in for its server with whether it can see it. A
/// folder's is for all the repositories `covered` gives, their server named when it has others. No
/// network.
fn read(data: &Path, p: &Project) -> io::Result<(Vec<Repo>, Vec<String>, Value)> {
    let found = match p.kind == crate::folder::KIND {
        true => covered(data, p),
        false => {
            let one = git::at(data, Path::new(&p.folder))
                .ok()
                .and_then(super::hosted)
                .filter(|(_, r)| r.kind == Kind::GitHub);
            Covered {
                repos: one.into_iter().collect(),
                more: false,
            }
        }
    };
    let ssh = found.repos.iter().any(|(c, _)| ssh(c));
    let repos: Vec<Repo> = found.repos.into_iter().map(|(_, r)| r).collect();
    let mut facts = json!({"folder": p.folder, "github": false, "logins": []});
    let Some(one) = repos.first() else {
        keep(data, p, &facts)?;
        return Ok((repos, vec![], facts));
    };
    let logins = logins(&GH, &one.host);
    let of = json!(repos.iter().map(Repo::key).collect::<Vec<_>>());
    let before = known(data, p);
    let last = |login: &String| {
        let mut all = before["logins"].as_array().into_iter().flatten();
        let one = all.find(|l| before["of"] == of && l["login"] == *login);
        one.map_or(Value::Null, |l| l["sees"].clone())
    };
    let all: Vec<Value> = (logins.iter())
        .map(|login| json!({"login": login, "sees": last(login)}))
        .collect();
    facts["github"] = true.into();
    facts["of"] = of;
    facts["host"] = json!(found.more.then_some(&one.host));
    facts["ssh"] = ssh.into();
    facts["logins"] = all.into();
    keep(data, p, &facts)?;
    Ok((repos, logins, facts))
}

/// Asks which accounts can see `id`'s repository and, where it has no account, saves the first that
/// can [D631], unless one was picked or its folder changed meanwhile. One that couldn't be asked
/// before any that can, or none that can, saves nothing: the next call asks again.
pub fn find(data: &Path, id: &str) -> io::Result<()> {
    let p = crate::projects::get(data, id)?;
    if p.removing {
        return Ok(());
    }
    let key = (p.id.clone(), p.folder.clone());
    {
        let mut probing = PROBING.lock().unwrap();
        if !probing.insert(key.clone()) {
            drop(
                PROBED
                    .wait_while(probing, |active| active.contains(&key))
                    .unwrap(),
            );
            return Ok(());
        }
    }
    let result = probe(data, &p);
    PROBING.lock().unwrap().remove(&key);
    PROBED.notify_all();
    result
}

fn probe(data: &Path, p: &Project) -> io::Result<()> {
    let (repos, logins, mut facts) = read(data, p)?;
    if logins.is_empty() {
        return Ok(());
    }
    let sees = sees(&repos.iter().collect::<Vec<_>>(), &logins);
    for (i, sees) in sees.iter().enumerate().filter(|(_, s)| s.is_some()) {
        facts["logins"][i]["sees"] = json!(sees);
    }
    keep(data, p, &facts)?;
    let first = (sees.iter().position(|s| *s != Some(false))).filter(|i| sees[*i] == Some(true));
    match first {
        Some(i) if p.github_account.is_none() => {
            crate::projects::found_account(data, &p.id, &p.folder, &logins[i])
        }
        _ => Ok(()),
    }
}

/// `find` in the background: an added project's, or one whose folder or account was cleared.
pub fn find_behind(data: &Path, id: &str) {
    let (data, id) = (data.to_path_buf(), id.to_string());
    thread::spawn(move || {
        let _ = find(&data, &id);
    });
}

/// At the daemon's start, refresh the projects' last answers and find any missing picks.
pub fn read_ahead(data: PathBuf) {
    thread::spawn(move || {
        let mut all = crate::projects::list(&data).unwrap_or_default();
        all.sort_by_key(|p| p.github_account.is_some());
        for p in all {
            let _ = find(&data, &p.id);
        }
    });
}

pub(super) const ENTERPRISE: &str = "GH_ENTERPRISE_TOKEN";

/// The variable gh takes `host`'s token from: another server's gh call must never be sent it.
pub(super) fn token_key(host: &str) -> &'static str {
    match host == "github.com" || host.ends_with(".ghe.com") {
        true => "GH_TOKEN",
        false => ENTERPRISE,
    }
}

/// Apply the project's account to each launch, including agent switches. Refuse a signed-out
/// pick before a child can inherit gh's active account, and keep the reason in its setup line.
pub fn launch(spec: &Spec, call: crate::send::Call<'_>, mut req: Value) -> io::Result<Value> {
    match session_env(&crate::data_of(spec), spec) {
        Ok(Some((key, token))) => req["env"][key] = token.into(),
        Ok(None) => {}
        Err(error) => {
            let reply = call(
                json!({"op": "note", "if_len": req["if_len"], "data": {"event": "spawn_failed",
                "cid": req["cid"], "backend": req["backend"], "error": error}}),
            )?;
            if reply["ok"] != true {
                return Ok(reply);
            }
            return Ok(json!({"ok": false, "result": "refused", "error": error}));
        }
    }
    call(req)
}

/// The token stays in the launch environment only; an unavailable explicit pick is an error.
fn session_env(data: &Path, spec: &Spec) -> Result<Option<(String, String)>, String> {
    let of = || {
        let id = spec.project.as_deref();
        id.map(|id| crate::projects::get(data, id)).transpose()
    };
    let mut project = of().map_err(|error| error.to_string())?;
    // A folder with no account yet finds it first; whatever the look ends in, the record says.
    if let Some(p) = &project
        && p.kind == crate::folder::KIND
        && p.github_account.is_none()
    {
        let _ = find(data, &p.id);
        project = of().map_err(|error| error.to_string())?;
    }
    let pick = project.as_ref().and_then(|p| p.github_account.clone());
    // A folder chat's is for all its project's repositories, whichever it claimed: its own folder
    // is no checkout.
    let folder = project.filter(|p| p.kind == crate::folder::KIND);
    let repos: Vec<Repo> = match &folder {
        Some(folder) => (covered(data, folder).repos.into_iter())
            .map(|(_, r)| r)
            .collect(),
        None if pick.is_some() => {
            let checkout = git::checkout(data, &Target::session(&spec.id))
                .map_err(|error| error.to_string())?;
            vec![picked_repo(&checkout).map_err(|error| error.to_string())?]
        }
        None => {
            let url = git::checkout(data, &Target::session(&spec.id))
                .and_then(|checkout| destination(&checkout).map(|(_, url)| url));
            match url {
                Ok(url) => super::repo(&url).into_iter().collect(),
                Err(_) => return Ok(None),
            }
        }
    };
    let repos: Vec<&Repo> = (repos.iter()).filter(|r| r.kind == Kind::GitHub).collect();
    let Some(host) = repos.first().map(|r| &r.host) else {
        return Ok(None);
    };
    let token = match folder.is_some() && pick.is_none() {
        true => None,
        false => {
            let gh = super::gh(repos[0], pick.as_deref());
            if gh.is_none()
                && let Some(login) = pick
            {
                return Err(signed_out(&login, host));
            }
            gh.and_then(|gh| gh.token)
        }
    };
    Ok(token.map(|token| (token_key(host).into(), token)))
}

#[test]
fn repository_url_uses_its_host() {
    let repo = Repo {
        kind: Kind::GitHub,
        host: "github.example.com".into(),
        path: "team/project".into(),
    };
    assert_eq!(repo.url(), "https://github.example.com/team/project");
}

/// Why `gh(repo, pick)` gave none: a picked account is named, as it's never read as another [D631].
pub(super) fn no_gh(repo: &Repo, pick: Option<&str>) -> String {
    match pick {
        Some(login) if repo.kind == Kind::GitHub && setup::find("gh", &[]).is_some() => {
            signed_out(login, &repo.host)
        }
        _ => super::NO_GH.into(),
    }
}

fn signed_out(login: &str, host: &str) -> String {
    format!(
        "The picked GitHub account @{login} is signed out. Sign in with gh auth login --hostname {host}, or choose another account in Project settings."
    )
}
