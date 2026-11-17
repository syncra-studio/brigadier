//! The accounts gh and glab keep signed in, read from their own config files: no network, no
//! keychain, no process [D624, D625, D629].

use crate::adapters;
use std::path::{Path, PathBuf};
use std::{env, fs};

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
