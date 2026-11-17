//! GitHub and GitLab through their own CLIs, gh and glab [D616]: every login each is signed in as,
//! read from its own config file (no network, no keychain) [D624, D625], and its own sign-in run in a terminal on a host as an agent's is (`setup-forge-<name>`), its
//! one-time code and page read from what it prints.

use super::{close, in_terminal, run_state, still_running};
use brigadier_core::adapters::{self, setup as tools};
use brigadier_core::{SETUP, Spec, session_dir};
use brigadier_frames::log::{self, Reader};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::{env, fs, io, iter, thread};

struct Forge {
    name: &'static str,
    label: &'static str,
    cli: &'static str,
    docs: &'static str,
    /// Its config folder: this variable, else this under XDG_CONFIG_HOME, else these under home.
    dir_var: &'static str,
    xdg: &'static str,
    homes: &'static [&'static str],
    file: &'static str,
    /// The keys over its host's entry: its active `user`, and every one under `users` where it keeps several.
    host: &'static [&'static str],
    sign_in: &'static [&'static str],
}

const FORGES: [Forge; 2] = [
    Forge {
        name: "github",
        label: "GitHub",
        cli: "gh",
        docs: "https://cli.github.com/manual/",
        dir_var: "GH_CONFIG_DIR",
        xdg: "gh",
        homes: &[".config/gh"],
        file: "hosts.yml",
        host: &["github.com"],
        sign_in: &[
            "auth",
            "login",
            "--hostname",
            "github.com",
            "--web",
            "--git-protocol",
            "https",
            "--skip-ssh-key",
        ],
    },
    Forge {
        name: "gitlab",
        label: "GitLab",
        cli: "glab",
        docs: "https://gitlab.com/gitlab-org/cli",
        dir_var: "GLAB_CONFIG_DIR",
        xdg: "glab-cli",
        homes: &["Library/Application Support/glab-cli", ".config/glab-cli"],
        file: "config.yml",
        host: &["hosts", "gitlab.com"],
        sign_in: &[
            "auth",
            "login",
            "--hostname",
            "gitlab.com",
            "--device",
            "--git-protocol",
            "https",
        ],
    },
];

pub(super) fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let Some(name) = args.get(1) else {
        let forges = thread::scope(|s| {
            let all = FORGES.each_ref().map(|f| s.spawn(move || card(data, f)));
            all.map(|t| t.join().unwrap_or_default())
        });
        return Ok(json!({"ok": true, "forges": forges}));
    };
    let f = (FORGES.iter().find(|f| f.name == name))
        .ok_or_else(|| io::Error::other(format!("unknown forge {name}")))?;
    let id = format!("{SETUP}forge-{}", f.name);
    match args.get(2).map(String::as_str) {
        Some("sign-in") => sign_in(data, f, &id),
        Some("close") => close(data, &id).map(|()| json!({"ok": true})),
        _ => Err(io::Error::other(
            "usage: brigadier forges [github|gitlab sign-in|close]",
        )),
    }
}

fn card(data: &Path, f: &Forge) -> Value {
    let exe = tools::find(f.cli, &[]);
    let logins = if exe.is_some() { logins(f) } else { vec![] };
    json!({"name": f.name, "label": f.label, "cli": exe.is_some(), "logins": logins, "docs": f.docs,
        "setup": state(data, &format!("{SETUP}forge-{}", f.name))})
}

/// The logins its CLI keeps for its host, the active one first.
fn logins(f: &Forge) -> Vec<String> {
    let home = adapters::home_path("");
    let dirs = (env::var_os(f.dir_var).map(PathBuf::from).into_iter())
        .chain(env::var_os("XDG_CONFIG_HOME").map(|x| Path::new(&x).join(f.xdg)))
        .chain(f.homes.iter().map(|h| home.join(h)));
    let file = dirs.map(|d| d.join(f.file)).find(|p| p.is_file());
    let text = file
        .and_then(|p| fs::read_to_string(p).ok())
        .unwrap_or_default();
    let active =
        (children(&text, f.host).into_iter()).filter_map(|(k, v)| (k == "user").then_some(v));
    let users = (children(&text, &[f.host, &["users"]].concat()).into_iter()).map(|(k, _)| k);
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

/// Its sign-in's state, with the one-time code and its page while it waits for them.
fn state(data: &Path, id: &str) -> Value {
    let mut state = run_state(data, id, None);
    if state["running"] != true {
        return state;
    }
    let mut out = vec![];
    if let Ok(mut r) = Reader::open(&session_dir(data, id).join("log"), 0, 0) {
        while let Ok(Some(f)) = r.next_with(|k| k == log::PTY) {
            out.extend_from_slice(&f.data);
        }
    }
    if let Some(code) = device_code(&String::from_utf8_lossy(&out)) {
        state["device_code"] = code.into();
        state["code_page"] = tools::code_page(&out).into();
    }
    state
}

/// gh and glab both print "First copy your one-time code: XXXX-XXXX"; gh, once it copied it,
/// "One-time code (XXXX-XXXX) copied to clipboard".
fn device_code(text: &str) -> Option<String> {
    let at = text.to_ascii_lowercase().find("one-time code")? + "one-time code".len();
    let code: String = (text[at..].trim_start_matches([':', ' ', '(']).chars())
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    (code.len() >= 4).then_some(code)
}

fn sign_in(data: &Path, f: &Forge, id: &str) -> io::Result<Value> {
    if let Some(running) = still_running(data, id)? {
        return Ok(running);
    }
    let exe = tools::find(f.cli, &[])
        .ok_or_else(|| io::Error::other(format!("{} ({}) isn't installed.", f.label, f.cli)))?;
    let spec = Spec {
        id: id.into(),
        backend: f.name.into(),
        mode: "pty".into(),
        cwd: adapters::home_path("").display().to_string(),
        opts: [("setup".to_string(), "sign-in".to_string())].into(),
        created: log::now_ms(),
        ..Default::default()
    };
    let mut env = adapters::base_env(&spec, &exe, &[]);
    // No questions in its own prompt, no colours or terminal queries: its code and page print at once.
    let quiet = [
        ("GH_PROMPT_DISABLED", "1"),
        ("NO_COLOR", "1"),
        ("TERM", "dumb"),
    ];
    env.extend(quiet.map(|(k, v)| (k.to_string(), v.to_string())));
    let argv = iter::once(exe.display().to_string()).chain(f.sign_in.iter().map(|w| w.to_string()));
    in_terminal(data, &spec, argv.collect(), env, Some(500), Some(10))
}
