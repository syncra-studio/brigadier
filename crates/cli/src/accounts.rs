//! Accounts and switching [D51]. Each extra account is its own CLI home under `accounts/<id>`,
//! signed in by the CLI's own sign-in in a terminal, so no credential is ever copied, shared or
//! seen; the computer's own login is never touched. Automatic switching is off until turned on,
//! per agent for accounts and once for agents. Off means
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
/// switch, when each account last hit a limit, the account each agent's new sessions start on
/// (`use`, none: the computer's login) and the name given to each agent's computer login [D2082].
pub(crate) fn load(data: &Path) -> Value {
    let v: Value = fs::read(data.join("accounts.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let list = |k: &str| v[k].as_array().cloned().unwrap_or_default();
    let map = |k: &str| v[k].as_object().cloned().unwrap_or_default();
    json!({"accounts": list("accounts"), "auto": list("auto"), "agents": v["agents"] == true,
        "limited": map("limited"), "use": map("use"), "names": map("names")})
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

/// An agent's accounts in order: the computer's login ("", named "" until renamed), then the extra
/// ones as added.
pub(crate) fn accounts_of(v: &Value, agent: &str) -> Vec<(String, String)> {
    let extra = v["accounts"].as_array().into_iter().flatten();
    let own = v["names"][agent].as_str().unwrap_or("").to_string();
    std::iter::once((String::new(), own))
        .chain(extra.filter(|e| e["agent"] == agent).map(|e| {
            let name = e["name"].as_str().unwrap_or("");
            // An added account went by "Account N" until it was named; that name was never given.
            let given = !name
                .strip_prefix("Account ")
                .is_some_and(|n| n.parse::<u32>().is_ok());
            (
                e["id"].as_str().unwrap_or("").to_string(),
                if given { name } else { "" }.to_string(),
            )
        }))
        .collect()
}

/// Signed in with a kind its home keeps apart: an account work can run on.
fn usable(c: &Value) -> bool {
    c["signed_in"] == true && c["kept_apart"] == true
}

/// A new session's spec with the account it starts on [D2082]: the one picked with Use while it is
/// still added and usable, else the computer's login. A session already made never moves.
pub(crate) fn starting(data: &Path, spec: Spec) -> Spec {
    let v = load(data);
    let id = v["use"][&spec.backend].as_str().unwrap_or("");
    let home = adapters::home_path("").display().to_string();
    let added = !id.is_empty() && accounts_of(&v, &spec.backend).iter().any(|(x, _)| x == id);
    let starts_on = (added.then(|| agent(&spec.backend).ok()).flatten())
        .filter(|a| usable(&check(*a, data, id, &home)))
        .map(|_| id.to_string());
    Spec { starts_on, ..spec }
}

/// What Home's agent check runs as: the account new sessions start on [D2082], so the models offered
/// are the ones a session there gets; the computer's login otherwise.
pub(crate) fn check_as(data: &Path, a: &dyn Adapter, cwd: &Path) -> Spec {
    let spec = Spec {
        backend: a.name().into(),
        ..Default::default()
    };
    match starting(data, spec).starts_on {
        Some(id) => on_account(a, data, &id, &cwd.display().to_string()),
        None => Spec::default(),
    }
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
                "email": c.who.email, "plan": c.who.plan, "org": c.who.org, "usage": c.usage,
                "kept_apart": id.is_empty() || kinds.contains(&c.how.as_str()),
                "models": c.models.iter().map(|m| m.id.clone()).collect::<Vec<_>>()})
        }
        Err(e) => json!({"installed": true, "error": e.trim()}),
    }
}

pub(crate) fn sign_in_id(agent: &str, id: &str) -> String {
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
        ("accounts", Some("remove")) => remove(data, args.get(2).map_or("", String::as_str)),
        ("accounts", Some(op @ ("use" | "rename"))) => {
            let arg = |i: usize| args.get(i).map_or("", String::as_str);
            name_or_use(data, op, agent(arg(2))?, arg(3), arg(4))
        }
        ("switching", _) => switching::set(data, args),
        ("rebirth", Some(id)) if args.iter().any(|a| a == "--go-on") => {
            switching::rebirth::go_on(data, id)
        }
        ("rebirth", Some(id)) => switching::rebirth::run(data, id),
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
                        let mut rows: Vec<Value> = checks
                            .into_iter()
                            .map(|(id, name, c)| {
                                json!({"id": id, "name": name, "check": c,
                                    "limited_until": v["limited"][format!("{}/{id}", a.name())],
                                    "sign_in": (!id.is_empty()).then(|| setup::run_state(data, &sign_in_id(a.name(), &id), Some(a)))})
                            })
                            .collect();
                        // The account picked with Use, while it is usable; else the computer's login.
                        let mut picked = v["use"][a.name()].as_str().unwrap_or("").to_string();
                        // The computer's login signed in to an account also added here: one row, the
                        // added one's, saying it is this computer's login, in use when either is.
                        let who = |c: &Value| {
                            (c["signed_in"] == true && c["email"].is_string()).then(|| {
                                (c["email"].as_str().unwrap_or("").to_lowercase(), c["org"].clone())
                            })
                        };
                        let own = who(&rows[0]["check"]);
                        if let Some(at) = own.and_then(|own| {
                            (1..rows.len()).find(|&i| who(&rows[i]["check"]).as_ref() == Some(&own))
                        }) {
                            rows[at]["own_login"] = true.into();
                            let in_use = picked.is_empty() || rows.iter().all(|r| r["id"] != picked);
                            rows.remove(0);
                            if in_use {
                                picked = rows[at - 1]["id"].as_str().unwrap_or("").to_string();
                            }
                        }
                        let in_use = rows.iter().any(|r| r["id"] == picked.as_str() && usable(&r["check"]));
                        json!({"vendor": acc.vendor, "list": rows, "auto": listed(v, "auto", a.name()),
                            "use": if in_use { picked.as_str() } else { "" }})
                    });
                    json!({"name": a.name(), "label": a.label(), "installed": a.exe().is_some(), "accounts": rows})
                })
            })
            .collect();
        jobs.into_iter().filter_map(|j| j.join().ok()).collect()
    });
    json!({"ok": true, "agents": out, "switch_agents": v["agents"]})
}

/// `accounts use <agent> <id>`: new sessions of the agent start on the account ("" the computer's
/// login). `accounts rename <agent> <id> <name>`: names it; emptied, it goes by who signed in
/// again [D2082].
fn name_or_use(data: &Path, op: &str, a: &dyn Adapter, id: &str, name: &str) -> io::Result<Value> {
    let _one = STORE.lock().unwrap();
    let mut v = load(data);
    if !accounts_of(&v, a.name()).iter().any(|(x, _)| x == id) {
        return Err(io::Error::other(format!("no account {id}")));
    }
    let name: String = name.trim().chars().take(60).collect();
    match (op, id) {
        ("use", "") => {
            v["use"].as_object_mut().unwrap().remove(a.name());
        }
        ("use", _) => v["use"][a.name()] = id.into(),
        (_, "") if name.is_empty() => {
            v["names"].as_object_mut().unwrap().remove(a.name());
        }
        (_, "") => v["names"][a.name()] = name.into(),
        _ => {
            let e = (v["accounts"].as_array_mut().unwrap().iter_mut())
                .find(|e| e["id"] == id)
                .unwrap();
            e["name"] = name.into();
        }
    }
    save(data, &v)?;
    Ok(json!({"ok": true}))
}

/// Finds an extra account by id: its agent and id.
pub(crate) fn find(data: &Path, id: &str) -> io::Result<(&'static dyn Adapter, String)> {
    core::check_id(id)?;
    let v = load(data);
    let e = (v["accounts"].as_array().into_iter().flatten())
        .find(|e| e["id"] == id)
        .ok_or_else(|| io::Error::other(format!("no account {id}")))?;
    Ok((agent(e["agent"].as_str().unwrap_or(""))?, id.to_string()))
}

/// Makes the account's home (0700) with its history links, then opens its sign-in, the setup's own.
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
        let name: String = name.unwrap_or("").trim().chars().take(60).collect();
        v["accounts"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id": id, "agent": a.name(), "name": name}));
        save(data, &v)?;
    }
    let run = sign_in_id(a.name(), &id);
    let mut reply = setup::start(data, a, &run, "sign-in", Some(&id), (cols, rows))?;
    reply["account"] = id.into();
    Ok(reply)
}

/// Removes an extra account: refused while any session runs on it or its sign-in is open [D51]. A
/// sign-in kind the home keeps apart is signed out by the CLI itself first; any other is left
/// alone, since signing it out could reach a login outside the home.
fn remove(data: &Path, id: &str) -> io::Result<Value> {
    let (a, id) = find(data, id)?;
    let run = sign_in_id(a.name(), &id);
    if setup::run_state(data, &run, None)["running"] == true {
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
    if v["use"][a.name()] == id.as_str() {
        v["use"].as_object_mut().unwrap().remove(a.name());
    }
    save(data, &v)?;
    Ok(json!({"ok": true, "note": note}))
}
