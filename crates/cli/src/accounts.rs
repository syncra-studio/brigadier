//! Accounts and switching [D51]. Each extra account is its own CLI home under `accounts/<id>`,
//! signed in by the CLI's own sign-in in a terminal, so no credential is ever copied, shared or
//! seen; the computer's own login is never touched. Automatic switching is off until turned on,
//! per agent for accounts and once for agents, and a released agent takes no part in it. Off means
//! no work at all: no probes, no switch. Nothing here names a provider: each adapter says how it
//! keeps accounts apart [D43].

use crate::{setup, switching};
use brigadier_core::adapters::{self, Adapter, probe_as};
use brigadier_core::{self as core, SETUP, Spec, account_home};
use serde_json::{Value, json};
use std::io;
use std::os::unix::fs::DirBuilderExt;
use std::path::Path;
use std::sync::Mutex;
use std::{fs, thread};

pub(crate) static STORE: Mutex<()> = Mutex::new(());

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).map(String::as_str)
}

/// `accounts.json`: the extra accounts, which agents switch accounts automatically, whether agents
/// switch, which agents are released, and when each account last hit a limit.
pub(crate) fn load(data: &Path) -> Value {
    let v: Value = fs::read(data.join("accounts.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let list = |k: &str| v[k].as_array().cloned().unwrap_or_default();
    json!({"accounts": list("accounts"), "auto": list("auto"), "released": list("released"),
        "agents": v["agents"] == true, "limited": v["limited"].as_object().cloned().unwrap_or_default()})
}

pub(crate) fn save(data: &Path, v: &Value) -> io::Result<()> {
    fs::create_dir_all(data)?;
    core::write_atomic(&data.join("accounts.json"), v.to_string().as_bytes())
}

pub(crate) fn listed(v: &Value, key: &str, agent: &str) -> bool {
    v[key]
        .as_array()
        .is_some_and(|l| l.iter().any(|a| a == agent))
}

/// Agents that take part in switching: every real provider, and the fake one when its accounts
/// are on for drills.
pub(crate) fn agents() -> impl Iterator<Item = &'static dyn Adapter> {
    adapters::all()
        .into_iter()
        .filter(|a| a.sign_in().is_some() || a.accounts().is_some())
}

pub(crate) fn agent(name: &str) -> io::Result<&'static dyn Adapter> {
    agents()
        .find(|a| a.name() == name)
        .ok_or_else(|| io::Error::other(format!("unknown agent {name}")))
}

/// An agent's accounts in order: the computer's login (""), then the extra ones as added.
pub(crate) fn accounts_of(v: &Value, agent: &str) -> Vec<(String, String)> {
    let extra = v["accounts"].as_array().into_iter().flatten();
    std::iter::once((String::new(), "this computer's login".to_string()))
        .chain(extra.filter(|e| e["agent"] == agent).map(|e| {
            (
                e["id"].as_str().unwrap_or("").to_string(),
                e["name"].as_str().unwrap_or("").to_string(),
            )
        }))
        .collect()
}

fn on_account(a: &dyn Adapter, data: &Path, id: &str, cwd: &str) -> Spec {
    Spec {
        cwd: cwd.into(),
        account: (!id.is_empty())
            .then(|| {
                a.accounts()
                    .map(|x| (x.var.to_string(), account_home(data, id)))
            })
            .flatten(),
        ..Default::default()
    }
}

/// The agent's own check on one account, in `cwd`: signed in, how, whether that sign-in kind is
/// kept apart, and the models usable there.
pub(crate) fn check(a: &dyn Adapter, data: &Path, id: &str, cwd: &str) -> Value {
    let Some(exe) = a.exe() else {
        return json!({"installed": false});
    };
    let spec = on_account(a, data, id, cwd);
    match a.check(&spec, &exe, Path::new(cwd)) {
        Ok(c) => {
            let kinds = a.accounts().map_or(&[][..], |x| x.kinds);
            json!({"installed": true, "signed_in": c.signed_in, "how": c.how,
                "kept_apart": id.is_empty() || kinds.contains(&c.how.as_str()),
                "models": c.models.iter().map(|(m, _)| m.clone()).collect::<Vec<_>>()})
        }
        Err(e) => json!({"installed": true, "error": e.trim()}),
    }
}

fn sign_in_id(agent: &str, id: &str) -> String {
    format!("{SETUP}{agent}-{id}")
}

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let size = |name: &str| flag(args, name).and_then(|n| n.parse::<u16>().ok());
    match (args[0].as_str(), args.get(1).map(String::as_str)) {
        ("accounts", None) => Ok(list(data)),
        ("accounts", Some("add")) => {
            let a = agent(args.get(2).map_or("", String::as_str))?;
            add(
                data,
                a,
                flag(args, "--name"),
                size("--cols"),
                size("--rows"),
            )
        }
        ("accounts", Some("sign-in")) => {
            let (a, id) = find(data, args.get(2).map_or("", String::as_str))?;
            sign_in(data, a, &id, size("--cols"), size("--rows"))
        }
        ("accounts", Some("close")) => {
            let (a, id) = find(data, args.get(2).map_or("", String::as_str))?;
            setup::close(data, &sign_in_id(a.name(), &id)).map(|()| json!({"ok": true}))
        }
        ("accounts", Some("remove")) => remove(data, args.get(2).map_or("", String::as_str)),
        ("switching", _) => switching::set(data, args),
        ("switch", Some(id)) => switching::switch_session(
            data,
            id,
            flag(args, "--account"),
            args.iter().any(|a| a == "--auto"),
        ),
        _ => Err(io::Error::other(crate::USAGE)),
    }
}

/// Every agent with its settings and accounts, each checked in its own home, side by side.
fn list(data: &Path) -> Value {
    let v = load(data);
    let home = adapters::home_path("").display().to_string();
    let out: Vec<Value> = thread::scope(|s| {
        let jobs: Vec<_> = agents()
            .map(|a| {
                let (v, home) = (&v, &home);
                s.spawn(move || {
                    let rows = a.accounts().map(|acc| {
                        let checks: Vec<_> = accounts_of(v, a.name())
                            .into_iter()
                            .map(|(id, name)| {
                                (id.clone(), name, check(a, data, &id, home))
                            })
                            .collect();
                        let rows: Vec<Value> = checks
                            .into_iter()
                            .map(|(id, name, c)| {
                                json!({"id": id, "name": name, "check": c,
                                    "limited_at": v["limited"][format!("{}/{id}", a.name())],
                                    "sign_in": (!id.is_empty()).then(|| setup::run_state(data, &sign_in_id(a.name(), &id), false))})
                            })
                            .collect();
                        json!({"vendor": acc.vendor, "list": rows, "auto": listed(v, "auto", a.name())})
                    });
                    json!({"name": a.name(), "label": a.label(), "installed": a.exe().is_some(),
                        "released": listed(v, "released", a.name()), "accounts": rows})
                })
            })
            .collect();
        jobs.into_iter().filter_map(|j| j.join().ok()).collect()
    });
    json!({"ok": true, "agents": out, "switch_agents": v["agents"]})
}

/// Finds an extra account by id: its agent and id.
fn find(data: &Path, id: &str) -> io::Result<(&'static dyn Adapter, String)> {
    core::check_id(id)?;
    let v = load(data);
    let e = (v["accounts"].as_array().into_iter().flatten())
        .find(|e| e["id"] == id)
        .ok_or_else(|| io::Error::other(format!("no account {id}")))?;
    Ok((agent(e["agent"].as_str().unwrap_or(""))?, id.to_string()))
}

/// Makes the account's home (0700) with its history links, then opens the CLI's own sign-in on it.
fn add(
    data: &Path,
    a: &dyn Adapter,
    name: Option<&str>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> io::Result<Value> {
    let acc = a
        .accounts()
        .ok_or_else(|| io::Error::other(format!("{} keeps one login only", a.label())))?;
    a.exe()
        .ok_or_else(|| io::Error::other(format!("{} is not installed", a.label())))?;
    let id = format!("a{}", &adapters::uuid()[..8]);
    let home = account_home(data, &id);
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&home)?;
    let main = adapters::home_path(acc.home);
    for link in acc.links {
        let target = main.join(link);
        // A history folder the CLI hasn't made yet is made now, so the account writes into it.
        if !link.contains('.') {
            fs::create_dir_all(&target)?;
        }
        if target.exists() {
            std::os::unix::fs::symlink(&target, home.join(link))?;
        }
    }
    {
        let _one = STORE.lock().unwrap();
        let mut v = load(data);
        let n = accounts_of(&v, a.name()).len() + 1;
        let name = name
            .map(|n| n.trim().chars().take(60).collect::<String>())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| format!("Account {n}"));
        v["accounts"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id": id, "agent": a.name(), "name": name}));
        save(data, &v)?;
    }
    sign_in(data, a, &id, cols, rows)
}

/// The CLI's own sign-in, with its home variable on the account, in a terminal [D45, D47].
fn sign_in(
    data: &Path,
    a: &dyn Adapter,
    id: &str,
    cols: Option<u16>,
    rows: Option<u16>,
) -> io::Result<Value> {
    let acc = a
        .accounts()
        .ok_or_else(|| io::Error::other("no accounts"))?;
    let run = sign_in_id(a.name(), id);
    if let Some(running) = setup::still_running(data, &run)? {
        return Ok(running);
    }
    let exe = a
        .exe()
        .ok_or_else(|| io::Error::other(format!("{} is not installed", a.label())))?;
    let mut spec = setup::setup_spec(a, &run, "account");
    spec.account = Some((acc.var.into(), account_home(data, id)));
    let argv = std::iter::once(exe.display().to_string())
        .chain(acc.sign_in.iter().map(|w| w.to_string()))
        .collect();
    let env = adapters::base_env(&spec, &exe, a.keys());
    let mut reply = setup::in_terminal(data, &spec, argv, env, cols, rows)?;
    reply["account"] = id.into();
    Ok(reply)
}

/// Removes an extra account: refused while any session runs on it or its sign-in is open [D51]. A
/// sign-in kind the home keeps apart is signed out by the CLI itself first; any other is left
/// alone, since signing it out could reach a login outside the home.
fn remove(data: &Path, id: &str) -> io::Result<Value> {
    let (a, id) = find(data, id)?;
    let run = sign_in_id(a.name(), &id);
    if setup::run_state(data, &run, false)["running"] == true {
        return Ok(
            json!({"ok": false, "error": "signing_in", "message": "Its sign-in is still open."}),
        );
    }
    let using: Vec<String> = core::ids(data)
        .into_iter()
        .filter(|s| {
            core::fold(&core::session_dir(data, s), true)
                .is_ok_and(|f| f.fold.accounts.get(a.name()) == Some(&id))
        })
        .collect();
    if !using.is_empty() {
        let n = using.len();
        return Ok(json!({"ok": false, "error": "in_use", "sessions": using,
            "message": format!("{n} session{} run{} on this account. Switch {} to another account first.",
                if n == 1 { "" } else { "s" }, if n == 1 { "s" } else { "" }, if n == 1 { "it" } else { "them" })}));
    }
    let home = account_home(data, &id);
    let c = check(a, data, &id, &adapters::home_path("").display().to_string());
    let mut note = Value::Null;
    if c["signed_in"] == true {
        match (c["kept_apart"] == true, a.accounts(), a.exe()) {
            (true, Some(acc), Some(exe)) => {
                let spec = on_account(a, data, &id, "");
                let out = probe_as(&spec, &exe, &home, a.keys(), acc.sign_out, 30)
                    .map_err(io::Error::other)?;
                if !out.status.success() {
                    let said = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    return Ok(
                        json!({"ok": false, "error": "sign_out", "message": format!("Signing out failed: {said}")}),
                    );
                }
            }
            _ => {
                note =
                    "Its sign-in kind isn't kept in its own folder, so it wasn't signed out.".into()
            }
        }
    }
    setup::close(data, &run)?;
    // Links are removed, never followed: the history they point at stays.
    match fs::remove_dir_all(&home) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let _one = STORE.lock().unwrap();
    let mut v = load(data);
    v["accounts"]
        .as_array_mut()
        .unwrap()
        .retain(|e| e["id"] != id.as_str());
    v["limited"]
        .as_object_mut()
        .unwrap()
        .remove(&format!("{}/{id}", a.name()));
    save(data, &v)?;
    Ok(json!({"ok": true, "note": note}))
}
