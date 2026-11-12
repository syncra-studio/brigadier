//! Providers and onboarding [D43, D45]: each adapter's check, its install and sign-in in a real
//! terminal on a host (`setup-<agent>`, see `core::SETUP`), and the profile onboarding fills in.
//! Nothing here names a provider; each adapter says how it is found, installed and signed in.

use crate::{accounts, flag, owner};
use brigadier_core::adapters::{self, Adapter, setup};
use brigadier_core::{self as core, SETUP, Spec, projects, repos, session_dir, writer};
use brigadier_frames::log;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use std::{fs, thread};

mod kept;
mod state;
use kept::{keep_check, last_check};
pub use state::run_state;

static PROFILE: Mutex<()> = Mutex::new(());

fn agent(name: &str) -> io::Result<&'static dyn Adapter> {
    adapters::get(name)
        .filter(|a| a.install().is_some() || a.sign_in().is_some() || a.accounts().is_some())
        .ok_or_else(|| io::Error::other(format!("unknown agent {name}")))
}

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let home = adapters::home_path("");
    match args.first().map(String::as_str).unwrap_or("") {
        // `--cached` never probes: a saved check, or the adapter's static card [D30, D272].
        "agents" => {
            let cwd = flag(args, "--cwd").map_or(home, PathBuf::from);
            let names = match args.get(1).filter(|a| !a.starts_with("--")) {
                Some(name) => vec![agent(name)?],
                None => available(),
            };
            let agents = agents(data, &cwd, names, args.iter().any(|a| a == "--cached"))?;
            Ok(json!({"ok": true, "agents": agents}))
        }
        "setup" => {
            let a = agent(args.get(1).map_or("", String::as_str))?;
            // `--account <id>`: an added account's sign-in, the same run in its own home [D51].
            let account = flag(args, "--account")
                .map(|id| accounts::find(data, id))
                .transpose()?;
            if account.as_ref().is_some_and(|(b, _)| b.name() != a.name()) {
                return Err(io::Error::other("that account is another agent's"));
            }
            let account = account.map(|(_, id)| id);
            let id = match &account {
                Some(acc) => accounts::sign_in_id(a.name(), acc),
                None => format!("{SETUP}{}", a.name()),
            };
            let size = |name: &str| flag(args, name).and_then(|n| n.parse::<u16>().ok());
            match args.get(2).map(String::as_str) {
                Some("close") => close(data, &id).map(|()| json!({"ok": true})),
                // `setup <agent> code <code>`: a code pasted from its sign-in's code page.
                Some("code") => send_code(data, a, &id, args.get(3).map_or("", String::as_str)),
                Some(action @ ("install" | "sign-in" | "update")) => {
                    let size = (size("--cols"), size("--rows"));
                    start(data, a, &id, action, account.as_deref(), size)
                }
                _ => Err(io::Error::other(
                    "usage: brigadier setup <agent> install|sign-in|update|close|code <code> [--account <id>]",
                )),
            }
        }
        "profile" => profile(data, args),
        "projects" => {
            // A folder picked with Add folder…: what adding it would add, after every guard;
            // nothing is written [D165].
            if let Some(path) = flag(args, "--check") {
                let repo = projects::check(data, path)?;
                let name = repo.file_name().map(|n| n.to_string_lossy().into_owned());
                return Ok(json!({"ok": true, "repo": repo, "name": name}));
            }
            // Each answers with the record, after the daemon has sent the change [D30, D40].
            let arg = |i: usize| args.get(i).map_or("", String::as_str);
            match arg(1) {
                "add" => {
                    let (id, name) = (flag(args, "--id"), flag(args, "--name"));
                    let project = projects::add(data, arg(2), id, name)?;
                    return Ok(json!({"ok": true, "project": project}));
                }
                "rename" => {
                    let project = projects::rename(data, arg(2), arg(3))?;
                    return Ok(json!({"ok": true, "project": project}));
                }
                "set" => {
                    let trusted = flag(args, "--trusted")
                        .map(|value| match value {
                            "true" => Ok(Some(true)),
                            "false" => Ok(Some(false)),
                            "none" => Ok(None),
                            _ => Err(io::Error::other("--trusted must be true, false or none")),
                        })
                        .transpose()?;
                    // `--include` is one path a line; empty copies none [D178].
                    let include =
                        flag(args, "--include").map(|v| v.lines().map(String::from).collect());
                    let change = projects::Change {
                        branch_prefix: flag(args, "--branch-prefix").map(String::from),
                        name: flag(args, "--name").map(String::from),
                        folder: flag(args, "--folder").map(String::from),
                        trusted,
                        setup: flag(args, "--setup").map(String::from),
                        include,
                    };
                    let project = projects::set(data, arg(2), change)?;
                    // The answer stays saved when a CLI's own entry can't be written [D166].
                    let failed = core::trust::sync(data, &project.id, None);
                    return Ok(json!({"ok": true, "project": project, "trust_errors": failed}));
                }
                "branches" => {
                    let folder = projects::get(data, arg(2))?.folder;
                    let repo = core::worktrees::branches(data, Path::new(&folder))?;
                    return Ok(json!({"ok": true, "repo": repo}));
                }
                "reveal" => {
                    let folder = projects::get(data, arg(2))?.folder;
                    let status = std::process::Command::new("open").arg(&folder).status()?;
                    if !status.success() {
                        return Err(io::Error::other(format!("Couldn't open {folder}")));
                    }
                    return Ok(json!({"ok": true}));
                }
                "remove" => return crate::sessions::remove_project(data, args),
                // Add project's (1f, 1g): `find`, `inspect <path>`, `clone <url|owner/name> --to
                // <dest> [--github] --id <id>`, `init <dest> [--here] --id <id>`, `github`.
                "find" => return Ok(json!({"ok": true, "repos": repos::find(data)?})),
                "inspect" => {
                    return Ok(json!({"ok": true, "check": repos::inspect(data, arg(2))?}));
                }
                "clone" => {
                    let (to, id) = (
                        flag(args, "--to").unwrap_or(""),
                        flag(args, "--id").unwrap_or(""),
                    );
                    let github = args.iter().any(|a| a == "--github");
                    let project = repos::clone(data, arg(2), to, github, id)?;
                    return Ok(json!({"ok": true, "project": project}));
                }
                "init" => {
                    let here = args.iter().any(|a| a == "--here");
                    let project =
                        repos::init(data, arg(2), here, flag(args, "--id").unwrap_or(""))?;
                    return Ok(json!({"ok": true, "project": project}));
                }
                "github" => {
                    return Ok(
                        json!({"ok": true, "github": brigadier_core::host::github_repos()?}),
                    );
                }
                _ => {}
            }
            let taken: Vec<String> = projects::list(data)?
                .into_iter()
                .map(|p| p.folder)
                .collect();
            let found = thread::scope(|s| {
                let all = adapters::all().map(|a| s.spawn(move || a.projects()));
                all.into_iter()
                    .flat_map(|t| t.join().unwrap_or_default())
                    .collect::<Vec<_>>()
            });
            // Each folder checked once (the history repeats them), and none macOS asks about.
            let home = adapters::home_path("");
            let home = fs::canonicalize(&home).unwrap_or(home);
            let (mut checked, mut seen) = (BTreeSet::new(), BTreeSet::new());
            let found: Vec<String> = found
                .iter()
                .filter(|p| !repos::protected(&home, p) && checked.insert(p.as_path()))
                .filter_map(|p| projects::root(p))
                .map(|p| p.display().to_string())
                .filter(|p| !taken.contains(p))
                .filter(|p| seen.insert(p.clone()))
                .take(30)
                .collect();
            Ok(json!({"ok": true, "found": found}))
        }
        _ => Err(io::Error::other(crate::USAGE)),
    }
}

fn available() -> Vec<&'static dyn Adapter> {
    adapters::all()
        .into_iter()
        .filter(|a| agent(a.name()).is_ok())
        .collect()
}

/// `update`: the command its Update runs, as typed; `models_off`: its models hidden from pickers.
fn card(data: &Path, a: &dyn Adapter) -> Value {
    let update = a
        .update(None)
        .map(|w| format!("{} {}", a.bin().0, w.join(" ")));
    json!({"name": a.name(), "label": a.label(), "short": a.short_label(), "install": a.install().is_some(),
        "sign_in": a.sign_in().map(|(label, _)| label), "setup": setup_state(data, a),
        "mark": a.mark(), "enabled": crate::settings::enabled(data, a.name()),
        "update": update.or(a.install().map(String::from)),
        "models_off": crate::settings::models_off(data, a.name())})
}

fn saved(data: &Path, a: &dyn Adapter, cwd: &Path) -> Value {
    let mut out = last_check(data, a, cwd).unwrap_or_else(|| json!({}));
    out.as_object_mut()
        .unwrap()
        .extend(card(data, a).as_object().unwrap().clone());
    out
}

fn now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64
}

/// The lock covers daemon threads and CLI processes, and dies with its holder. A caller that
/// waited reuses checks completed since it arrived; an interrupted check is tried again.
fn agents(
    data: &Path,
    cwd: &Path,
    names: Vec<&'static dyn Adapter>,
    cached: bool,
) -> io::Result<Vec<Value>> {
    if cached {
        return Ok(names.into_iter().map(|a| saved(data, a, cwd)).collect());
    }
    fs::create_dir_all(data.join("agents"))?;
    let path = data.join("agents/check.lock");
    let before = fs::read(&path).unwrap_or_default();
    let mut lock = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)?;
    lock.lock()?;
    let completed = fs::read(&path)?;
    let last: Value = serde_json::from_slice(&completed).unwrap_or_default();
    if completed != before
        && last["cwd"] == cwd.to_str().unwrap_or("")
        && names.iter().all(|a| {
            last["names"]
                .as_array()
                .is_some_and(|v| v.iter().any(|n| n == a.name()))
        })
    {
        return Ok(names.into_iter().map(|a| saved(data, a, cwd)).collect());
    }
    setup::refresh();
    let checks: Vec<Value> = thread::scope(|s| {
        let checks: Vec<_> = names
            .iter()
            .map(|a| s.spawn(move || check(data, *a, cwd)))
            .collect();
        checks
            .into_iter()
            .map(|t| {
                t.join()
                    .unwrap_or_else(|_| Err(io::Error::other("agent check panicked")))
            })
            .collect::<io::Result<_>>()
    })?;
    // Publish completion only after every cache was saved. A crash leaves waiters free to retry.
    let completed = json!({"cwd": cwd, "names": names.iter().map(|a| a.name()).collect::<Vec<_>>(), "at": now_ns()});
    lock.set_len(0)?;
    lock.write_all(completed.to_string().as_bytes())?;
    Ok(checks)
}

/// Installed, signed in and usable models are separate [D45]. Only Rust probes and saves them.
fn check(data: &Path, a: &dyn Adapter, cwd: &Path) -> io::Result<Value> {
    let mut out = card(data, a);
    // One that doesn't really run is not installed: Install, never Sign in [D32].
    let exe = a.exe().filter(|exe| setup::runs(exe, cwd));
    out["path"] = exe.as_ref().map(|p| p.display().to_string()).into();
    if let Some(exe) = exe {
        // Its updater's newest version, looked up meanwhile: only a newer one offers Update. While a
        // setup run is open, checked every few seconds, the last one found stands.
        let kept = || last_check(data, a, cwd).and_then(|v| v["latest"].as_str().map(String::from));
        let (checked, latest) = thread::scope(|s| {
            let latest = s.spawn(|| match out["setup"].is_null() {
                true => a.latest(),
                false => kept(),
            });
            let checked = a.check(&accounts::check_as(data, a, cwd), &exe, cwd);
            (checked, latest.join().ok().flatten())
        });
        match checked {
            Ok(c) => {
                let older: Vec<&str> = (c.models.iter().filter(|m| m.legacy))
                    .map(|m| m.id.as_str())
                    .collect();
                crate::settings::older_off(data, a.name(), &older)?;
                out["models_off"] = crate::settings::models_off(data, a.name()).into();
                let newer = latest
                    .as_deref()
                    .is_some_and(|l| setup::newer(l, &c.version));
                out["outdated"] = newer.into();
                out["latest"] = latest.into();
                out["version"] = c.version.into();
                out["signed_in"] = c.signed_in.into();
                out["how"] = c.how.into();
                out["plan"] = c.who.plan.into();
                out["logins"] = c.logins.into();
                out["models"] = c
                    .models
                    .into_iter()
                    .map(|m| json!({"id": m.id, "name": m.name, "local": m.local, "efforts": m.efforts, "default_effort": m.default_effort, "retiring": m.retiring, "images": m.images, "fast": m.fast, "legacy": m.legacy, "window": m.window}))
                    .collect();
            }
            Err(e) => out["error"] = e.trim().into(),
        }
    }
    keep_check(data, a, cwd, &out)?;
    Ok(out)
}

/// The agent's setup run: which, whether it still runs, and how it ended.
fn setup_state(data: &Path, a: &dyn Adapter) -> Value {
    run_state(data, &format!("{SETUP}{}", a.name()), Some(a))
}

/// Types a code pasted from the sign-in's code page into the sign-in, as its adapter takes it.
fn send_code(data: &Path, a: &dyn Adapter, id: &str, code: &str) -> io::Result<Value> {
    let code = a.sign_in_code(code).map_err(io::Error::other)?;
    let ping = owner::call(data, id, json!({"op": "ping"})).unwrap_or_default();
    if ping["child"].is_null() || !a.code_page() {
        let label = a.label();
        return Err(io::Error::other(format!(
            "{label}'s sign-in isn't waiting for a code. Sign in again."
        )));
    }
    let reply = owner::call(
        data,
        id,
        json!({"op": "keys", "spawn": ping["spawn"], "bytes": format!("{code}\r")}),
    )?;
    if reply["ok"] != true {
        return Err(io::Error::other(
            reply["error"]
                .as_str()
                .unwrap_or("The sign-in didn't take the code.")
                .to_string(),
        ));
    }
    Ok(json!({"ok": true}))
}

/// Runs the vendor's installer, or the CLI's own sign-in or updater (else its installer again), in a
/// terminal on a host [D45, D60, D2082]. The setup run's action names which; an added account's
/// sign-in is its CLI's own, with its home variable on the account.
/// A run still going is shown again; an ended one is replaced.
pub(crate) fn start(
    data: &Path,
    a: &dyn Adapter,
    id: &str,
    action: &str,
    account: Option<&str>,
    (cols, rows): (Option<u16>, Option<u16>),
) -> io::Result<Value> {
    if let Some(running) = still_running(data, id)? {
        return Ok(running);
    }
    let mut spec = setup_spec(a, id, action);
    let home = account.zip(a.accounts());
    if let Some((acc, x)) = &home {
        spec.account = Some((x.var.into(), core::account_home(data, acc)));
    }
    let words = match (action, home) {
        ("sign-in", Some((_, x))) => Some(x.sign_in),
        ("sign-in", None) => Some(a.sign_in().ok_or_else(|| io::Error::other("no sign-in"))?.1),
        ("update", _) => a.update(a.exe().as_deref()),
        _ => None,
    };
    let (argv, env) = if let Some(words) = words {
        let exe = a
            .exe()
            .ok_or_else(|| io::Error::other(format!("{} is not installed", a.label())))?;
        let argv =
            std::iter::once(exe.display().to_string()).chain(words.iter().map(|w| w.to_string()));
        (argv.collect(), adapters::base_env(&spec, &exe, a.keys()))
    } else {
        let line = a
            .install()
            .ok_or_else(|| io::Error::other("no installer"))?;
        let shell = Path::new("/bin/bash");
        let argv = vec![
            shell.display().to_string(),
            "-c".into(),
            format!("set -o pipefail; {line}"),
        ];
        (argv, adapters::base_env(&spec, shell, &[]))
    };
    in_terminal(data, &spec, argv, env, cols, rows)
}

/// A run still going is shown again; an ended one is replaced.
pub fn still_running(data: &Path, id: &str) -> io::Result<Option<Value>> {
    if session_dir(data, id).join("session.json").exists() {
        let ping = owner::call(data, id, json!({"op": "ping"})).unwrap_or_default();
        if !ping["child"].is_null() {
            return Ok(Some(json!({"ok": true, "id": id, "running": true})));
        }
        close(data, id)?;
    }
    Ok(None)
}

pub fn setup_spec(a: &dyn Adapter, id: &str, action: &str) -> Spec {
    Spec {
        id: id.into(),
        backend: a.name().into(),
        mode: "pty".into(),
        cwd: adapters::home_path("").display().to_string(),
        opts: [("setup".to_string(), action.to_string())].into(),
        created: log::now_ms(),
        ..Default::default()
    }
}

/// Starts `argv` in a terminal on the setup run's own host [D45, D60].
pub fn in_terminal(
    data: &Path,
    spec: &Spec,
    argv: Vec<String>,
    env: Vec<(String, String)>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> io::Result<Value> {
    let spec = core::create(data, spec)?;
    owner::ensure(data, &spec)?;
    let env: serde_json::Map<String, Value> = env.into_iter().map(|(k, v)| (k, v.into())).collect();
    // The environment reaches the host over its socket only: the log records the argv, never it.
    let req = json!({"op": "spawn", "argv": argv, "env": env, "cwd": spec.cwd, "pty": true, "keep_stdin": true,
        "cols": cols.unwrap_or(100), "rows": rows.unwrap_or(30), "backend": spec.backend});
    let mut reply = owner::call(data, &spec.id, req)?;
    reply["id"] = spec.id.clone().into();
    Ok(reply)
}

/// Stops a setup run and removes its folder: nothing of it stays [D35].
pub fn close(data: &Path, id: &str) -> io::Result<()> {
    let _ = owner::call(data, id, json!({"op": "stop", "by": "user"}));
    owner::release(data, id)?;
    match fs::remove_dir_all(session_dir(data, id)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

fn read_profile(data: &Path) -> Value {
    let p: Value = fs::read(data.join("profile.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    json!({"name": p["name"].as_str().unwrap_or(""), "git_writer": p["git_writer"], "intro_seen": p["intro_seen"] == true,
        "onboarded": p["onboarded"] == true})
}

/// `profile [--name N] [--intro] [--done]`: what onboarding keeps, in `profile.json`. Projects
/// are records of their own (`projects`); a write here drops the plain paths they moved from.
fn profile(data: &Path, args: &[String]) -> io::Result<Value> {
    let _one = PROFILE.lock().unwrap();
    // The plain paths move to the records before a write here drops them.
    projects::list(data)?;
    let mut p = read_profile(data);
    if let Some(name) = flag(args, "--name") {
        p["name"] = name.trim().chars().take(80).collect::<String>().into();
    }
    let has = |f: &str| args.iter().any(|a| a == f);
    if has("--git-writer") {
        let value = flag(args, "--git-writer").ok_or_else(|| io::Error::other(super::USAGE))?;
        p["git_writer"] = json!(writer::parse_choice(serde_json::from_str(value)?)?);
    }
    p["intro_seen"] = (p["intro_seen"] == true || has("--intro")).into();
    p["onboarded"] = (p["onboarded"] == true || has("--done")).into();
    if args.len() > 1 {
        fs::create_dir_all(data)?;
        core::write_atomic(&data.join("profile.json"), p.to_string().as_bytes())?;
    }
    p["ok"] = true.into();
    if args.len() == 1 {
        p["agents"] = agents(data, &adapters::home_path(""), available(), true)?.into();
    }
    Ok(p)
}
