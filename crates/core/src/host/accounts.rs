//! The accounts gh and glab keep signed in, read from their own config files: no network, no
//! keychain, no process [D624, D625, D629]; and a project's GitHub account [D631].

use super::{Gh, Kind, reads, token};
use crate::Spec;
use crate::adapters::{self, setup};
use crate::git::{self, Target, push};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
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

/// Project settings' GitHub account: whether `id`'s repository is on GitHub, each account signed in
/// for its server with whether it can see it, and the one Automatic uses (the first that can).
/// Without `probe`, no network: `sees` and `auto` are null, so the row draws at once.
pub fn seen(data: &Path, id: &str, probe: bool) -> io::Result<Value> {
    let checkout = git::checkout(data, &Target::Project(id))?;
    let Ok((remote, url)) = destination(&checkout) else {
        return Ok(json!({"ok": true, "github": false}));
    };
    let Some(repo) = super::repo(&url).filter(|r| r.kind == Kind::GitHub) else {
        return Ok(json!({"ok": true, "github": false}));
    };
    // get-url includes insteadOf/pushInsteadOf rewrites, which can turn HTTPS into SSH.
    let effective = git::read(
        &checkout.root,
        &["remote", "get-url", "--push", &remote],
        &AtomicBool::new(false),
    )
    .ok();
    let effective = effective.as_deref().map(String::from_utf8_lossy);
    let url = effective.as_deref().unwrap_or(&url);
    let ssh = url
        .split_once("://")
        .map_or_else(|| url.contains(':'), |(scheme, _)| scheme.contains("ssh"));
    let gh = setup::find("gh", &[]).and_then(|p| Some(p.to_str()?.to_string()));
    let logins = logins(&GH, &repo.host);
    if !probe {
        let all: Vec<Value> = (logins.iter())
            .map(|login| json!({"login": login, "sees": null}))
            .collect();
        return Ok(
            json!({"ok": true, "github": true, "repo": repo.path, "ssh": ssh, "auto": null, "logins": all}),
        );
    }
    let sees: Vec<bool> = thread::scope(|s| {
        let probes = logins.iter().map(|login| {
            let (gh, repo) = (gh.as_deref(), &repo);
            s.spawn(move || {
                let path = gh?.to_string();
                let token = Some(token(&path, &repo.host, login)?);
                Some(reads(&Gh { path, token }, repo))
            })
        });
        let probes: Vec<_> = probes.collect();
        (probes.into_iter())
            .map(|p| p.join().ok().flatten().unwrap_or(false))
            .collect()
    });
    let auto = (logins.iter().zip(&sees)).find_map(|(login, sees)| sees.then_some(login));
    let all: Vec<Value> = (logins.iter().zip(&sees))
        .map(|(login, sees)| json!({"login": login, "sees": sees}))
        .collect();
    Ok(
        json!({"ok": true, "github": true, "repo": repo.path, "ssh": ssh, "auto": auto, "logins": all}),
    )
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
    let pick = spec
        .project
        .as_deref()
        .map(|id| crate::projects::get(data, id))
        .transpose()
        .map_err(|error| error.to_string())?
        .and_then(|project| project.github_account);
    let url = git::checkout(data, &Target::session(&spec.id))
        .and_then(|checkout| destination(&checkout).map(|(_, url)| url));
    let url = match url {
        Ok(url) => url,
        Err(error) if pick.is_some() => return Err(error.to_string()),
        Err(_) => return Ok(None),
    };
    let Some(repo) = super::repo(&url).filter(|repo| repo.kind == Kind::GitHub) else {
        return Ok(None);
    };
    let gh = super::gh(&repo, pick.as_deref());
    if gh.is_none()
        && let Some(login) = pick
    {
        return Err(format!(
            "The picked GitHub account @{login} is signed out. Sign in with gh auth login --hostname {}, or choose another account in Project settings.",
            repo.host
        ));
    }
    Ok(gh
        .and_then(|gh| gh.token)
        .map(|token| ("GH_TOKEN".into(), token)))
}
