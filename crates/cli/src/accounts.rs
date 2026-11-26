//! Accounts and switching [D51]. Each extra account is its own CLI home under `accounts/<id>`,
//! signed in by the CLI's own sign-in in a terminal, so no credential is ever copied, shared or
//! seen; the computer's own login is never touched. Automatic switching is off until turned on,
//! per agent for accounts and once for agents. Off means
//! no work at all: no probes, no switch. Nothing here names a provider: each adapter says how it
//! keeps accounts apart [D43].

use crate::{setup, switching, usage};
use brigadier_core::adapters::{self, Adapter, probe_as};
use brigadier_core::{self as core, SETUP, Spec, account_home};
use serde_json::{Value, json};
use std::io;
use std::os::unix::fs::DirBuilderExt;
use std::path::Path;
use std::sync::Mutex;
use std::{fs, thread};

mod start;
pub(crate) use start::{check_as, fell_back, login_ok, picked, starting, tell, told};

pub(crate) static STORE: Mutex<()> = Mutex::new(());

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).map(String::as_str)
}

/// `accounts.json`: the extra accounts, which agents switch accounts automatically, whether agents
/// switch, when each account last hit a limit, the account each agent's new sessions start on
/// (`use`, none: the computer's login), the name given to each agent's computer login [D2082] and
/// when each removed account went (`removed`, by id) [C40].
pub(crate) fn load(data: &Path) -> Value {
    let v: Value = fs::read(data.join("accounts.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let list = |k: &str| v[k].as_array().cloned().unwrap_or_default();
    let map = |k: &str| v[k].as_object().cloned().unwrap_or_default();
    json!({"accounts": list("accounts"), "auto": list("auto"), "agents": v["agents"] == true,
        "limited": map("limited"), "limited_at": map("limited_at"), "use": map("use"), "names": map("names"), "removed": map("removed")})
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
        // One Remove is taking away is no longer offered [C40].
        .chain(
            extra
                .filter(|e| e["agent"] == agent && !core::marked(e))
                .map(|e| {
                    let name = e["name"].as_str().unwrap_or("");
                    // An added account went by "Account N" until it was named; that name was never given.
                    let given = !name
                        .strip_prefix("Account ")
                        .is_some_and(|n| n.parse::<u32>().is_ok());
                    (
                        e["id"].as_str().unwrap_or("").to_string(),
                        if given { name } else { "" }.to_string(),
                    )
                }),
        )
        .collect()
}

/// Signed in with a kind its home keeps apart: an account work can run on.
pub(crate) fn usable(c: &Value) -> bool {
    c["signed_in"] == true && c["kept_apart"] == true
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
/// kept apart, the models usable there, and the limits known of it, kept for every reader [D2039].
pub(crate) fn check(a: &dyn Adapter, data: &Path, id: &str, cwd: &str) -> Value {
    let Some(exe) = a.exe() else {
        return json!({"installed": false});
    };
    let spec = on_account(a, data, id, cwd);
    match a.check(&spec, &exe, Path::new(cwd)) {
        Ok(c) => {
            usage::checked(data, a.name(), id, &c);
            // Only the windows known now: an unknown one draws as not read yet.
            let known: Vec<_> = (usage::of(data, a.name(), id).into_iter())
                .filter(|w| w.used.is_some())
                .collect();
            json!({"installed": true, "signed_in": c.signed_in, "how": c.how,
                "email": c.who.email, "plan": c.who.plan, "org": c.who.org, "usage": usage::limits(&known),
                "kept_apart": kept_apart(a, id, &c.how),
                "models": c.models.iter().map(|m| m.id.clone()).collect::<Vec<_>>()})
        }
        Err(e) => json!({"installed": true, "error": e.trim()}),
    }
}

/// Whether an account's login kind is one its own home keeps apart; the computer's login always is.
pub(crate) fn kept_apart(a: &dyn Adapter, id: &str, how: &str) -> bool {
    id.is_empty() || a.accounts().is_some_and(|x| x.kinds.contains(&how))
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
        ("accounts", Some("remove")) => remove(
            data,
            args.get(2).map_or("", String::as_str),
            args.iter().any(|a| a == "--check"),
        ),
        ("accounts", Some(op @ ("use" | "rename"))) => {
            let arg = |i: usize| args.get(i).map_or("", String::as_str);
            name_or_use(data, op, agent(arg(2))?, arg(3), arg(4))
        }
        ("switching", _) => switching::set(data, args),
        ("rebirth", Some(id)) if args.iter().any(|a| a == "--go-on") => {
            switching::rebirth::go_on(data, id)
        }
        ("rebirth", Some(id)) => switching::rebirth::run(data, id),
        ("reset", Some(id)) => switching::reset::run(data, id),
        ("reconnect", Some(id)) => {
            switching::reconnect::run(data, id, args.iter().any(|a| a == "--now"))
        }
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
                                json!({"id": id, "name": name, "check": c, "usage": usage::limits(&usage::of(data, a.name(), &id)),
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

/// Removes an extra account: refused while a chat on it is working or its sign-in is open [D51].
/// The chats it ran go on with the computer's login: its home gone, they read as on it [C40].
/// `check`: only how many chats it ran, for the confirm. A sign-in kind the home keeps apart is
/// signed out by the CLI itself first; any other is left alone, since signing it out could reach
/// a login outside the home.
fn remove(data: &Path, id: &str, check_only: bool) -> io::Result<Value> {
    let (a, id) = find(data, id)?;
    let on = |s: &String| {
        core::fold(&core::session_dir(data, s), true)
            .is_ok_and(|f| f.fold.accounts.get(a.name()) == Some(&id))
    };
    if check_only {
        let chats = core::ids(data).iter().filter(|s| on(s)).count();
        return Ok(json!({"ok": true, "chats": chats}));
    }
    let run = sign_in_id(a.name(), &id);
    if setup::run_state(data, &run, None)["running"] == true {
        return Ok(
            json!({"ok": false, "error": "signing_in", "message": "Its sign-in is still open."}),
        );
    }
    // Marked first: no turn starts on it, nor a switch to it [D172]. Any failure takes it off.
    mark(data, &id, true)?;
    let done = take_away(data, a, &id, &run, on);
    if !done.as_ref().is_ok_and(|v| v["ok"] == true) {
        mark(data, &id, false)?;
    }
    done
}

/// Remove's work once its mark is on.
fn take_away(
    data: &Path,
    a: &dyn Adapter,
    id: &str,
    run: &str,
    on: impl Fn(&String) -> bool,
) -> io::Result<Value> {
    // Each turn start that passed its fence before the mark is waited out, so the fold shows it.
    let ids = core::ids(data);
    for s in &ids {
        drop(core::worktrees::lock(&core::session_dir(data, s)));
    }
    let all = crate::procs::all();
    let using: Vec<&String> = ids.iter().filter(|s| on(s)).collect();
    // A commit message or PR text being written may run on it too, outside a chat's turn and on
    // an account its chat's fold may not name: any of them waits.
    let writing = |s: &String| {
        core::writer::writing(&core::session_dir(data, s)).is_ok_and(|w| w.try_lock().is_err())
    };
    let n = (using.iter())
        .filter(|s| crate::sessions::working(data, s, &all))
        .count()
        + ids.iter().filter(|s| writing(s)).count();
    if n > 0 {
        let (s, them) = if n == 1 {
            ("chat is", "it")
        } else {
            ("chats are", "them")
        };
        return Ok(json!({"ok": false, "error": "in_use",
            "message": format!("{n} {s} working on this account. Wait for {them} to finish or stop {them} first.")}));
    }
    // An idle child kept between turns runs in its home: stopped, its next launch is the login's.
    // One that won't stop keeps the account.
    for s in using {
        if crate::owner::state(data, s) == core::fold::Owner::Alive {
            crate::owner::call(data, s, json!({"op": "stop", "by": "account"}))?;
            core::background::end_left(&core::session_dir(data, s))?;
            crate::owner::release(data, s)?;
        }
    }
    let home = account_home(data, id);
    let c = check(a, data, id, &adapters::home_path("").display().to_string());
    let mut note = Value::Null;
    if c["signed_in"] == true {
        match (c["kept_apart"] == true, a.accounts(), a.exe()) {
            (true, Some(acc), Some(exe)) => {
                let spec = on_account(a, data, id, "");
                let out = probe_as(&spec, &exe, &home, &a.keys(), acc.sign_out, 30)
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
    setup::close(data, run)?;
    // From here its chats are on the login: their folds drop it at this time, kept before the
    // home goes, so a crash between leaves it said [C40].
    {
        let _one = STORE.lock().unwrap();
        let mut v = load(data);
        v["removed"][id] = brigadier_frames::log::now_ms().into();
        save(data, &v)?;
    }
    // Links are removed, never followed: the history they point at stays.
    match fs::remove_dir_all(&home) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => {
            let _one = STORE.lock().unwrap();
            let mut v = load(data);
            v["removed"].as_object_mut().unwrap().remove(id);
            save(data, &v)?;
            return Err(e);
        }
        _ => {}
    }
    let _one = STORE.lock().unwrap();
    let mut v = load(data);
    v["accounts"]
        .as_array_mut()
        .unwrap()
        .retain(|e| e["id"] != id);
    for k in ["limited", "limited_at"] {
        v[k].as_object_mut()
            .unwrap()
            .remove(&format!("{}/{id}", a.name()));
    }
    if v["use"][a.name()] == id {
        v["use"].as_object_mut().unwrap().remove(a.name());
    }
    save(data, &v)?;
    drop(_one);
    usage::forget(data, a.name(), id)?;
    Ok(json!({"ok": true, "note": note}))
}

/// Sets or clears Remove's mark on added account `id`: this process's id, so a crash's lapses [C40].
fn mark(data: &Path, id: &str, on: bool) -> io::Result<()> {
    let _one = STORE.lock().unwrap();
    let mut v = load(data);
    for e in v["accounts"].as_array_mut().unwrap() {
        if e["id"] == id {
            e["removing"] = on.then(std::process::id).into();
        }
    }
    save(data, &v)
}
