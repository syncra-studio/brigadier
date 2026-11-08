//! Providers and onboarding [D43, D45]: each adapter's check, its install and sign-in in a real
//! terminal on a host (`setup-<agent>`, see `core::SETUP`), and the profile onboarding fills in.
//! Nothing here names a provider; each adapter says how it is found, installed and signed in.

use crate::owner;
use brigadier_core::adapters::{self, Adapter, setup};
use brigadier_core::{self as core, SETUP, Spec, projects, repos, session_dir};
use brigadier_frames::log::{self, Reader};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::{fs, thread};

/// Adapters with a check running: one at a time each, so a stuck CLI never piles up probes.
static BUSY: Mutex<BTreeSet<&str>> = Mutex::new(BTreeSet::new());
static PROFILE: Mutex<()> = Mutex::new(());

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).map(String::as_str)
}

fn agent(name: &str) -> io::Result<&'static dyn Adapter> {
    adapters::get(name)
        .filter(|a| a.install().is_some() || a.sign_in().is_some())
        .ok_or_else(|| io::Error::other(format!("unknown agent {name}")))
}

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let home = adapters::home_path("");
    match args.first().map(String::as_str).unwrap_or("") {
        // `agents [<name>] [--cwd D] [--cached]`: every agent (reading the login shell again first,
        // since an install may have changed it), or one, checked in the folder a session would run
        // in. `--cached` answers at once with each agent's last check there, checking only one never
        // checked; the page asks again without it to refresh [D30].
        "agents" => {
            let cwd = flag(args, "--cwd").map_or(home, PathBuf::from);
            let cached = args.iter().any(|a| a == "--cached");
            let names: Vec<&str> = match args.get(1).filter(|a| !a.starts_with("--")) {
                Some(name) => vec![agent(name)?.name()],
                None => {
                    if !cached {
                        setup::refresh();
                    }
                    let all = adapters::all().into_iter();
                    all.filter(|a| agent(a.name()).is_ok())
                        .map(|a| a.name())
                        .collect()
                }
            };
            let checks: Vec<_> = names
                .into_iter()
                .map(|name| {
                    let (data, cwd) = (data.to_path_buf(), cwd.clone());
                    thread::spawn(move || {
                        let a = agent(name).unwrap();
                        match last_check(&data, a, &cwd).filter(|_| cached) {
                            Some(mut last) => {
                                last["setup"] = setup_state(&data, a);
                                last
                            }
                            None => check(&data, a, &cwd),
                        }
                    })
                })
                .collect();
            let agents: Vec<Value> = checks.into_iter().filter_map(|t| t.join().ok()).collect();
            Ok(json!({"ok": true, "agents": agents}))
        }
        "setup" => {
            let a = agent(args.get(1).map_or("", String::as_str))?;
            let id = format!("{SETUP}{}", a.name());
            let size = |name: &str| flag(args, name).and_then(|n| n.parse::<u16>().ok());
            match args.get(2).map(String::as_str) {
                Some("close") => close(data, &id).map(|()| json!({"ok": true})),
                // `setup <agent> code <code>`: a code pasted from its sign-in's code page.
                Some("code") => send_code(data, a, &id, args.get(3).map_or("", String::as_str)),
                Some(action @ ("install" | "sign-in")) => {
                    start(data, a, &id, action, size("--cols"), size("--rows"))
                }
                _ => Err(io::Error::other(
                    "usage: brigadier setup <agent> install|sign-in|close|code <code>",
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
                "remove" => {
                    projects::remove(data, arg(2))?;
                    return Ok(json!({"ok": true}));
                }
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
                "github" => return Ok(json!({"ok": true, "github": repos::github()?})),
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
            let mut seen = BTreeSet::new();
            let found: Vec<String> = found
                .iter()
                .filter_map(|p| setup::repo(p))
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

/// One agent's state [D45]: installed (where, which version), signed in (and how), and the models a
/// session in `cwd` can pick, which may be none even when signed in; plus its setup run, if any.
fn check(data: &Path, a: &dyn Adapter, cwd: &Path) -> Value {
    let mut out = json!({"name": a.name(), "label": a.label(), "install": a.install().is_some(),
        "sign_in": a.sign_in().map(|(label, _)| label), "setup": setup_state(data, a),
        "mark": a.mark()});
    if !BUSY.lock().unwrap().insert(a.name()) {
        out["busy"] = true.into();
        return out;
    }
    let exe = a.exe();
    out["path"] = exe.as_ref().map(|p| p.display().to_string()).into();
    if let Some(exe) = exe {
        match a.check(&Spec::default(), &exe, cwd) {
            Ok(c) => {
                out["version"] = c.version.into();
                out["signed_in"] = c.signed_in.into();
                out["how"] = c.how.into();
                out["models"] = c
                    .models
                    .into_iter()
                    .map(|(id, local)| json!({"id": id, "local": local}))
                    .collect();
            }
            Err(e) => out["error"] = e.trim().into(),
        }
    }
    BUSY.lock().unwrap().remove(a.name());
    keep_check(data, a, cwd, &out);
    out
}

/// Each agent's last check per folder: `agents/<name>.json`, `{cwd: check}`.
fn checks_path(data: &Path, a: &dyn Adapter) -> PathBuf {
    data.join("agents").join(format!("{}.json", a.name()))
}

fn last_check(data: &Path, a: &dyn Adapter, cwd: &Path) -> Option<Value> {
    let all: Value = serde_json::from_slice(&fs::read(checks_path(data, a)).ok()?).ok()?;
    all.get(cwd.to_str()?).cloned()
}

/// Keeps the check for the next `--cached` ask. Best effort: losing it costs one slow open.
fn keep_check(data: &Path, a: &dyn Adapter, cwd: &Path, out: &Value) {
    let path = checks_path(data, a);
    let mut all: Value = fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({}));
    if let (Some(map), Some(cwd)) = (all.as_object_mut(), cwd.to_str()) {
        map.insert(cwd.into(), out.clone());
        let _ = fs::create_dir_all(path.parent().unwrap());
        let _ = core::write_atomic(&path, all.to_string().as_bytes());
    }
}

/// The agent's setup run: which, whether it still runs, and how it ended.
fn setup_state(data: &Path, a: &dyn Adapter) -> Value {
    run_state(data, &format!("{SETUP}{}", a.name()), a.code_page())
}

/// A setup run's state: which, whether it still runs, and how it ended; with `code_pages`, the
/// code page a running sign-in printed.
pub fn run_state(data: &Path, id: &str, code_pages: bool) -> Value {
    let Ok(spec) = core::load(data, id) else {
        return Value::Null;
    };
    let ping = owner::call(data, id, json!({"op": "ping"})).unwrap_or_default();
    let running = !ping["child"].is_null();
    let action = spec.opts.get("setup").map(String::as_str);
    // Its output is read only while a sign-in that offers a code page runs.
    let page = running && action == Some("sign-in") && code_pages;
    let (mut exited, mut out) = (Value::Null, Vec::new());
    if let Ok(mut r) = Reader::open(&spec.dir.join("log"), 0, 0) {
        let wanted = |k| k == log::EXITED || (page && k == log::PTY);
        while let Ok(Some(f)) = r.next_with(wanted) {
            if f.kind == log::EXITED {
                exited = serde_json::from_slice(&f.data).unwrap_or_default();
            } else if f.kind == log::PTY {
                out.extend_from_slice(&f.data);
            }
        }
    }
    json!({"id": id, "action": action, "running": running, "code": exited["code"],
        "signal": exited["signal"], "code_page": code_page(&out)})
}

/// The first `https` link a sign-in printed, up to a space or a control character (a terminal
/// link's own escape ends it).
fn code_page(out: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(out);
    let start = text.find("https://")?;
    let page = text[start..]
        .chars()
        .take_while(|c| !c.is_whitespace() && !c.is_control());
    Some(page.collect())
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

/// Runs the vendor's installer, or the CLI's own sign-in, in a terminal on a host [D45, D47, D60].
/// A run still going is shown again; an ended one is replaced.
fn start(
    data: &Path,
    a: &dyn Adapter,
    id: &str,
    action: &str,
    cols: Option<u16>,
    rows: Option<u16>,
) -> io::Result<Value> {
    if let Some(running) = still_running(data, id)? {
        return Ok(running);
    }
    let spec = setup_spec(a, id, action);
    let (argv, env) = if action == "install" {
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
    } else {
        let (_, words) = a.sign_in().ok_or_else(|| io::Error::other("no sign-in"))?;
        let exe = a
            .exe()
            .ok_or_else(|| io::Error::other(format!("{} is not installed", a.label())))?;
        let argv =
            std::iter::once(exe.display().to_string()).chain(words.iter().map(|w| w.to_string()));
        (argv.collect(), adapters::base_env(&spec, &exe, a.keys()))
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

/// Starts `argv` in a terminal on the setup run's own host [D47, D60].
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
    json!({"name": p["name"].as_str().unwrap_or(""), "intro_seen": p["intro_seen"] == true,
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
    if has("--intro") {
        p["intro_seen"] = true.into();
    }
    if has("--done") {
        p["onboarded"] = true.into();
    }
    if args.len() > 1 {
        fs::create_dir_all(data)?;
        core::write_atomic(&data.join("profile.json"), p.to_string().as_bytes())?;
    }
    p["ok"] = true.into();
    Ok(p)
}
