//! `plugins [add '<json>' | install <id> '<scope>' [client_id] | use <id> '<scope>' | sync | ask | set <key> '<json>' | remove <key> |
//! show|reveal <key> | signin|wait|cancel|signout <key> | browse server|skill <query>]`: Settings › Plugins [D2043, D2046]. Each prints the library's
//! items, what the agents have on this machine among them [D721], and the projects; `signin` its URL, `browse` what it found.

mod browse;
mod catalog;
mod found;
mod view;

use brigadier_core::library::{self, secrets};
use brigadier_core::{adapters, projects};
use serde_json::{Map, Value, json};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

/// One change of the library at a time.
static LOCK: Mutex<()> = Mutex::new(());

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let arg = |i: usize| args.get(i).map(String::as_str).unwrap_or("");
    let json = |i: usize| {
        serde_json::from_str::<Value>(arg(i)).map_err(|e| io::Error::other(format!("plugins: {e}")))
    };
    // A sign-in is the daemon's, outside the library's lock: `wait` waits on a browser.
    if let verb @ ("signin" | "wait" | "cancel" | "signout") = arg(1) {
        let r = crate::signin::run(data, &[verb, arg(2)]);
        return Ok(match (verb, r["ok"] == true) {
            ("signin", _) | (_, false) => r,
            _ => list(data),
        });
    }
    // A search reaches the internet, outside the library's lock [D434].
    if arg(1) == "browse" {
        return browse::run(data, arg(2), &args[3.min(args.len())..].join(" "));
    }
    match arg(1) {
        "show" => return view::show(data, arg(2)),
        "reveal" => return view::reveal(data, arg(2)),
        // After `sync`, outside the lock: the page waits on this, not the changes behind it [D721].
        "ask" => {
            found::ask(data);
            return Ok(list(data));
        }
        _ => {}
    }
    let _one = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if !matches!(arg(1), "" | "sync") {
        crate::signin::DENIED.store(false, std::sync::atomic::Ordering::SeqCst);
    }
    match arg(1) {
        "" => {}
        // The page shows the library first, then asks for this [D721].
        "sync" => found::sync(data)?,
        verb @ ("add" | "install") => {
            let added = match verb {
                "add" => add(data, json(2)?),
                _ => catalog::install(data, arg(2), json(3)?, arg(4)),
            };
            let _ = std::fs::remove_dir_all(browse::incoming(data));
            let mut page = list(data);
            page["added"] = added?.into();
            return Ok(page);
        }
        "set" => set(data, arg(2), json(3)?)?,
        // Its agent's own plugin, on: in the library at once, as found [D608, D721].
        "use" => {
            catalog::use_plugin(data, arg(2), json(3)?)?;
            found::sync(data)?;
            let data = data.to_path_buf();
            std::thread::spawn(move || found::ask(&data));
        }
        "remove" => remove(data, arg(2))?,
        _ => {
            return Err(io::Error::other(
                "usage: brigadier plugins [add '<json>' | install <id> '<scope>' [client_id] | use <id> '<scope>' | sync | ask | set <key> '<json>' | remove <key> | show|reveal <key> | signin|wait|cancel|signout <key> | browse server|skill <query>]",
            ));
        }
    }
    Ok(list(data))
}

/// What the agents have, into the library as a new session starts [D721]: in the background, so
/// the session starts at once with what's installed already.
pub fn sync(data: &Path) {
    let data = data.to_path_buf();
    std::thread::spawn(move || {
        {
            let _one = LOCK.lock().unwrap_or_else(|e| e.into_inner());
            // A failure leaves the library as it was.
            let _ = found::sync(&data);
        }
        found::ask(&data);
    });
}

/// A project's folders its own are read from: its folder, and a folder of repositories' each
/// repository too, where the agents keep a repository's own [D494, D669].
fn folders_of(p: &projects::Project) -> Vec<PathBuf> {
    let top = PathBuf::from(&p.folder);
    let repos = match p.kind == brigadier_core::folder::KIND {
        true => brigadier_core::folder::repos(&top),
        false => vec![],
    };
    let inside: Vec<PathBuf> = repos.iter().map(|r| top.join(r)).collect();
    [top].into_iter().chain(inside).collect()
}

fn str(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn list(data: &Path) -> Value {
    let items = library::items(data);
    let all = projects::list(data).unwrap_or_default();
    let agents: Vec<_> = crate::setup::available().into_iter().collect();
    let projects: Vec<Value> = (all.iter())
        .map(|p| json!({"id": p.id, "name": p.name}))
        .collect();
    // A project's folder is read only once trusted, as the "/" menu's [D2098].
    let folders: Vec<PathBuf> = (all.iter())
        .filter(|p| p.trusted == Some(true))
        .flat_map(folders_of)
        .collect();
    // Each agent's own copies at home, or in a project's folder [D2098].
    let mut own: Vec<(&dyn adapters::Adapter, Value)> = vec![];
    for a in &agents {
        for f in folders.iter().map(|f| Some(f.as_path())).chain([None]) {
            let skills = a.fixed_commands(f, None).into_iter();
            own.extend(skills.filter(|k| k["kind"] == "skill").map(|k| (*a, k)));
        }
    }
    let shown: Vec<Value> = (items.iter())
        .map(|i| {
            let detail = match i["kind"] == "skill" {
                true => json!(library::skill_dir(data, i)),
                false => library::detail(i).into(),
            };
            // Where an agent's own skill of its name stays on, that agent uses its own [D415].
            let mut kept: Vec<&str> = (own.iter())
                .filter(|(a, k)| i["kind"] == "skill" && a.own_skill_wins() && k["name"] == i["name"])
                .map(|(a, _)| a.label())
                .collect();
            kept.dedup();
            // The user's own folders of it, which Remove leaves as they are.
            let mut own_folders: Vec<&Path> = (own.iter())
                .filter(|(_, k)| i["kind"] == "skill" && found::is(k, str(&i["name"])))
                .flat_map(|(_, k)| [&k["path"]].into_iter().chain(k["also"].as_array().into_iter().flatten()))
                .filter_map(|p| Path::new(str(p)).parent())
                .collect();
            let added = i["added_from"].as_str().map(Path::new);
            own_folders.extend(added.filter(|f| f.join("SKILL.md").is_file()));
            own_folders.sort();
            own_folders.dedup();
            let note = match i["sign_in"] == "cli" {
                true => Some("Signed in by each agent.".to_string()),
                false => (!kept.is_empty()).then(|| {
                    format!("{} uses your own copy of this skill.", kept.join(" and "))
                }),
            };
            let key = str(&i["key"]);
            let ours = i["sign_in"] == "brigadier";
            let status = match ours {
                true if i["on"] != true => json!("off"),
                true => crate::signin::status(data, key).into(),
                false => Value::Null,
            };
            let signed_in = ours.then(|| crate::signin::signed_in(data, key));
            json!({"key": i["key"], "kind": i["kind"], "name": i["name"], "description": i["description"],
                "detail": detail, "on": i["on"] == true, "scope": i["scope"], "status": status,
                "sign_in": i.get("sign_in"), "signed_in": signed_in, "agents": agents.iter().map(|a| a.label()).collect::<Vec<_>>(),
                "note": note, "catalog": catalog::id(i), "with": i.get("with"), "set": i.get("set"), "from": i.get("from"), "found": i.get("found"), "folders": own_folders})
        })
        .collect();
    json!({"ok": true, "items": shown, "projects": projects, "catalog": catalog::page(&items)})
}

fn refuse(why: &str) -> io::Error {
    io::Error::other(why.to_string())
}

/// A name every agent's config takes as a key, and the thread splits back out [D176].
fn plain(name: &str) -> io::Result<()> {
    let ok = |c: char| c.is_ascii_alphanumeric() || c == '-';
    match !name.is_empty() && name.len() <= 64 && !name.starts_with('-') && name.chars().all(ok) {
        true => Ok(()),
        false => Err(refuse(&format!(
            "{name:?} can't be a name: use letters, digits and dashes."
        ))),
    }
}

/// `{kind: "skill", folder}`; `{kind: "skill", source, skill}` from Browse, its folder fetched from GitHub first;
/// `{kind: "server", name, url, client_id?}`; `{kind: "server", name, command, args, env}`, its
/// command shown in the install dialog first. An install is on where picked, `scope` [D571 D727],
/// all projects without one; `on: false` keeps it off. Answers the new item's key.
fn add(data: &Path, mut v: Value) -> io::Result<String> {
    let (on, scope) = (v["on"] != false, v["scope"].clone());
    if let Some(source) = v["source"].as_str() {
        let folder = browse::fetch(data, source, &[str(&v["skill"])])?.remove(0);
        v = json!({"kind": "skill", "folder": folder});
    }
    let mut items = library::items(data);
    let skill = v["kind"] == "skill";
    let name = match skill {
        true => Path::new(str(&v["folder"]))
            .file_name()
            .map(|n| found::plain(&n.to_string_lossy())),
        false => v["name"].as_str().map(String::from),
    };
    let name = name.unwrap_or_default();
    plain(&name)?;
    let key = format!("{}:{name}", if skill { "skill" } else { "server" });
    if items.iter().any(|i| i["key"] == *key) {
        return Err(refuse(&format!("The library already has {name}.")));
    }
    let mut item = json!({"key": key, "kind": if skill { "skill" } else { "server" }, "name": name,
        "on": on, "scope": {"all": true}});
    // The catalog's service a skill came with [D572].
    if let Some(with) = v["with"].as_str() {
        item["with"] = with.into();
    }
    if !scope.is_null() {
        item["scope"] = scope_of(&scope)?;
    }
    if skill {
        // A linked skill's own folder, so the copy outlives the link.
        let from = std::fs::canonicalize(str(&v["folder"]))
            .map_err(|_| refuse("That folder has no SKILL.md."))?;
        let text = std::fs::read_to_string(from.join("SKILL.md"))
            .map_err(|_| refuse("That folder has no SKILL.md."))?;
        item["description"] = crate::relay::described(&text).into();
        // The user's folder it's copied from; one fetched from Browse isn't theirs.
        if !Path::new(str(&v["folder"])).starts_with(browse::incoming(data)) {
            item["added_from"] = v["folder"].clone();
        }
        let to = library::dir(data).join("skills");
        std::fs::create_dir_all(&to)?;
        // An earlier add's leftover, never listed.
        let _ = std::fs::remove_dir_all(to.join(&name));
        let copied = Command::new("/bin/cp")
            .arg("-R")
            .arg(&from)
            .arg(to.join(&name))
            .status()?;
        if !copied.success() {
            return Err(refuse(&format!("Couldn't copy {}.", from.display())));
        }
    } else if let Some(url) = v["url"].as_str() {
        item["url"] = url.into();
        // An API key's header: its value to the Keychain item, only its name here. A server given
        // one isn't asked how it signs in.
        let headers: Map<String, Value> = v["headers"].as_object().cloned().unwrap_or_default();
        // A public client id, for a server that won't let Brigadier register itself [D578].
        let client = v["client_id"].as_str().filter(|c| !c.trim().is_empty());
        if let Some(id) = client {
            item["client_id"] = id.trim().into();
        }
        if headers.is_empty() {
            item["sign_in"] = crate::signin::kind(url, client.is_some())
                .map_err(|e| refuse(&e))?
                .into();
        }
        item["headers"] = headers.keys().cloned().collect::<Vec<_>>().into();
        if !headers.is_empty() {
            secrets::update(data, |p| {
                p.insert(key.clone(), json!({ "headers": headers }));
            })?;
        }
    } else {
        let command = v["command"].as_str().filter(|c| !c.trim().is_empty());
        item["command"] = command
            .ok_or_else(|| refuse("A server needs a URL or a command."))?
            .into();
        item["args"] = v["args"].as_array().cloned().unwrap_or_default().into();
        // Every value goes to the Keychain item, only its name here.
        let env: Map<String, Value> = v["env"].as_object().cloned().unwrap_or_default();
        item["secrets"] = env.keys().cloned().collect::<Vec<_>>().into();
        if !env.is_empty() {
            secrets::update(data, |p| {
                p.insert(key.clone(), json!({ "env": env }));
            })?;
        }
    }
    items.push(item);
    // Added again, it's no longer removed; a failure leaves nothing added and it still removed.
    let gone = library::removed(data);
    let left: Vec<String> = gone.iter().filter(|k| **k != key).cloned().collect();
    let back = left.len() < gone.len();
    let cleared = match back {
        true => library::save_removed(data, &left),
        false => Ok(()),
    };
    if let Err(e) = cleared.and_then(|()| library::save(data, &items)) {
        let _ = forget(data, &key, &name);
        if back {
            let _ = library::save_removed(data, &gone);
        }
        return Err(e);
    }
    Ok(key)
}

/// Whether `key` names this item: its own, or `skillset:<id>` for each skill that came with `id`,
/// or that was found in set `id` [D720].
fn is(i: &Value, key: &str) -> bool {
    let set = key.strip_prefix("skillset:");
    i["key"] == key
        || set.is_some_and(|w| i["kind"] == "skill" && (i["with"] == w || i["set"] == w))
}

/// `{all: true}` or `{projects: [<id>]}`.
fn scope_of(s: &Value) -> io::Result<Value> {
    match s {
        s if s["all"] == true => Ok(json!({"all": true})),
        s if s["projects"]
            .as_array()
            .is_some_and(|p| p.iter().all(Value::is_string)) =>
        {
            Ok(json!({"projects": s["projects"]}))
        }
        _ => Err(refuse(
            "A scope is {\"all\": true} or {\"projects\": [ids]}.",
        )),
    }
}

/// `{on?, scope?: {all: true} | {projects: [<id>]}}`; `skillset:<id>` is every skill that came
/// with the catalog's `id` [D580].
fn set(data: &Path, key: &str, v: Value) -> io::Result<()> {
    let mut items = library::items(data);
    let these: Vec<&mut Value> = items.iter_mut().filter(|i| is(i, key)).collect();
    if these.is_empty() {
        return Err(refuse("That item is no longer in the library."));
    }
    let scope = match v["scope"].is_null() {
        true => None,
        false => Some(scope_of(&v["scope"])?),
    };
    for item in these {
        if let Some(on) = v["on"].as_bool() {
            item["on"] = on.into();
        }
        if let Some(scope) = &scope {
            item["scope"] = scope.clone();
        }
    }
    library::save(data, &items)
}

fn remove(data: &Path, key: &str) -> io::Result<()> {
    let mut items = library::items(data);
    let Some(at) = items.iter().position(|i| i["key"] == key) else {
        return Ok(());
    };
    if items[at]["kind"] == "skill" {
        return remove_skill(data, items, at);
    }
    // It follows the agent's settings [D721].
    if let Some(from) = items[at]["from"].as_str() {
        return Err(refuse(&format!(
            "{from}: remove it there, or switch it off here."
        )));
    }
    // Signed out first, its grant revoked where the server offers that.
    if items[at]["url"].is_string() {
        crate::signin::run(data, &["signout", key]);
    }
    // A service's skills go with it [D572].
    let with = catalog::id(&items[at]);
    let server = items[at]["kind"] == "server" && !with.is_null();
    let gone = |i: &Value| i["key"] == key || (server && i["kind"] == "skill" && i["with"] == with);
    // Their folders and secrets first, so a failed cleanup stays listed to retry.
    for i in items.iter().filter(|i| gone(i)) {
        forget(data, str(&i["key"]), str(&i["name"]))?;
    }
    items.retain(|i| !gone(i));
    library::save(data, &items)
}

/// A skill's Remove: Brigadier's own copy is deleted, the user's folders never are. Its key is kept
/// as removed first, so `found::sync` leaves out any found by its name until it's added again.
fn remove_skill(data: &Path, mut items: Vec<Value>, at: usize) -> io::Result<()> {
    let item = items.remove(at);
    let key = str(&item["key"]);
    let mut gone = library::removed(data);
    if !gone.iter().any(|k| k == key) {
        gone.push(key.into());
        library::save_removed(data, &gone)?;
    }
    if item["found"].is_null() {
        forget(data, key, str(&item["name"]))?;
    }
    library::save(data, &items)?;
    // Those left of its set are grouped again [D720].
    found::sync(data)
}

/// Its skill folder and its secrets; the Keychain item goes with the last [D2043].
fn forget(data: &Path, key: &str, name: &str) -> io::Result<()> {
    if key.starts_with("skill:") {
        let folder = library::dir(data).join("skills").join(name);
        std::fs::remove_dir_all(&folder).or_else(|e| match e.kind() {
            io::ErrorKind::NotFound => Ok(()),
            _ => Err(e),
        })?;
    }
    secrets::update(data, |p| {
        p.remove(key);
    })
}
