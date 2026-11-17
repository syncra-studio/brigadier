//! `plugins [add '<json>' | install <id> '<scope>' | set <key> '<json>' | remove <key> |
//! signin|wait|cancel|signout <key> | browse server|skill <query>]`: Settings › Plugins [D2043, D2046]. Each prints the library's
//! items, each agent's own (read only) and the projects; `signin` its URL, `browse` what it found.

mod browse;
mod catalog;

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
    let _one = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match arg(1) {
        "" => {}
        verb @ ("add" | "install") => {
            let added = match verb {
                "add" => add(data, json(2)?),
                _ => catalog::install(data, arg(2), json(3)?),
            };
            let _ = std::fs::remove_dir_all(browse::incoming(data));
            let mut page = list(data);
            page["added"] = added?.into();
            return Ok(page);
        }
        "set" => set(data, arg(2), json(3)?)?,
        "remove" => remove(data, arg(2))?,
        _ => {
            return Err(io::Error::other(
                "usage: brigadier plugins [add '<json>' | install <id> '<scope>' | set <key> '<json>' | remove <key> | signin|wait|cancel|signout <key> | browse server|skill <query>]",
            ));
        }
    }
    Ok(list(data))
}

/// Each skill (its folder) and server (its URL or command) in the agents' own settings, once
/// however many agents have it [D424]: those at home first, then each trusted project's own that
/// aren't at home too, `project` its name, once under each project [D430]. `in_library` where the
/// library holds one of its name, URL or command.
fn own(lib: &[Value], projects: &[projects::Project]) -> Vec<Value> {
    let home = adapters::home_path("");
    let agents: Vec<_> = crate::setup::available().into_iter().collect();
    let skills = |a: &dyn adapters::Adapter, folder: Option<&Path>| -> Vec<Value> {
        (a.fixed_commands(folder, None).into_iter())
            .filter(|k| {
                k["kind"] == "skill" && k["path"].is_string() && !str(&k["name"]).contains(':')
            })
            // A project's own are those in its folder.
            .filter(|k| folder.is_none_or(|f| Path::new(str(&k["path"])).starts_with(f)))
            .map(|k| {
                let folder = Path::new(str(&k["path"])).parent().map(Path::to_path_buf);
                json!({"kind": "skill", "name": k["name"], "detail": folder})
            })
            .collect()
    };
    let servers = |a: &dyn adapters::Adapter, folder: Option<&Path>| -> Vec<Value> {
        let at_home = a.mcp_servers(&home);
        let here = folder.map_or_else(|| at_home.clone(), |f| a.mcp_servers(f));
        (here.into_iter())
            .filter(|s| folder.is_none() || !at_home.contains(s))
            .map(|mut s| {
                s["kind"] = "server".into();
                s["detail"] = library::detail(&s).into();
                s
            })
            .collect()
    };
    // A project's folder is read only once trusted, as the "/" menu's [D2098].
    let places = [None].into_iter().chain(
        (projects.iter())
            .filter(|p| p.trusted == Some(true))
            .map(Some),
    );
    let mut all: Vec<Value> = vec![];
    for p in places {
        let folder = p.map(|p| PathBuf::from(&p.folder));
        let id = p.map_or("", |p| p.id.as_str());
        for a in &agents {
            let found = skills(*a, folder.as_deref());
            for mut o in found.into_iter().chain(servers(*a, folder.as_deref())) {
                let kin = |x: &Value| x["kind"] == o["kind"] && same(&o, x);
                // One at home too is shown there only.
                if p.is_some() && all.iter().any(|x| x["place"] == "" && kin(x)) {
                    continue;
                }
                if let Some(row) = all.iter_mut().find(|x| x["place"] == id && kin(x)) {
                    let names = row["agents"].as_array_mut();
                    if let Some(names) = names.filter(|n| !n.contains(&a.label().into())) {
                        names.push(a.label().into());
                    }
                    row["sources"][a.label()] = o["source"].clone();
                    continue;
                }
                let key = format!("own:{id}:{}:{}", str(&o["kind"]), str(&o["name"]));
                let held = |i: &&Value| i["kind"] == o["kind"];
                o["in_library"] = (lib.iter().filter(held)).any(|i| same(&o, i)).into();
                o["project"] = p.map(|p| p.name.clone()).into();
                (o["key"], o["agents"], o["place"]) = (key.into(), json!([a.label()]), id.into());
                // Where each agent has it from: a server's file or plugin [D565].
                o["sources"] = json!({ a.label(): o["source"] });
                all.push(o);
            }
        }
    }
    all
}

fn same(own: &Value, item: &Value) -> bool {
    match own["kind"] == "skill" {
        true => own["name"] == item["name"],
        false => library::same(own, item),
    }
}

/// A plugin's server by its own name: `plugin:slack:slack` → `slack` [D565].
fn shown(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

/// Where the agents have it: "From Claude Code's slack plugin", else "In Codex's settings".
fn from(own: &Value) -> String {
    let sources = own["sources"].as_object().cloned().unwrap_or_default();
    // A plugin's is `plugin <plugin>@<marketplace>` [D565]; a file's is its path.
    let plugin = (sources.iter()).find_map(|(agent, s)| {
        let key = str(s).strip_prefix("plugin ")?;
        Some(format!(
            "From {agent}'s {} plugin",
            key.split('@').next().unwrap_or(key)
        ))
    });
    plugin.unwrap_or_else(|| {
        let agents: Vec<&str> = (own["agents"].as_array().into_iter().flatten())
            .map(str)
            .collect();
        let all = match agents.split_last() {
            Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
            _ => agents.join(""),
        };
        format!("In {all}'s settings")
    })
}

fn str(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn list(data: &Path) -> Value {
    let items = library::items(data);
    let all = projects::list(data).unwrap_or_default();
    // Only what the page draws: an own server's env and headers may hold its token. One the library
    // holds isn't listed [D445].
    let own: Vec<Value> = (own(&items, &all).into_iter())
        .filter(|o| o["in_library"] != true)
        .map(|o| {
            json!({"key": o["key"], "kind": o["kind"], "name": shown(str(&o["name"])), "detail": o["detail"],
            "agents": o["agents"], "project": o["project"], "sources": o["sources"], "from": from(&o)})
        })
        .collect();
    let agents: Vec<_> = crate::setup::available().into_iter().collect();
    let projects: Vec<Value> = (all.iter())
        .map(|p| json!({"id": p.id, "name": p.name}))
        .collect();
    // A project's folder is read only once trusted, as the "/" menu's [D2098].
    let folders: Vec<PathBuf> = (all.iter())
        .filter(|p| p.trusted == Some(true))
        .map(|p| PathBuf::from(&p.folder))
        .collect();
    let shown: Vec<Value> = (items.iter())
        .map(|i| {
            let detail = match i["kind"] == "skill" {
                true => json!(library::dir(data).join("skills").join(str(&i["name"]))),
                false => library::detail(i).into(),
            };
            // Where an agent's own skill of its name stays on, that agent uses its own [D415].
            // Its own copies at home, or in a project's folder [D2098].
            let has = |a: &&&dyn adapters::Adapter| {
                let here = folders.iter().map(|f| Some(f.as_path())).chain([None]);
                here.flat_map(|f| a.fixed_commands(f, None))
                    .any(|k| k["kind"] == "skill" && k["name"] == i["name"])
            };
            let kept: Vec<&str> = (agents.iter())
                .filter(|a| i["kind"] == "skill" && a.own_skill_wins())
                .filter(has)
                .map(|a| a.label())
                .collect();
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
                "note": note, "catalog": catalog::id(i), "with": i.get("with")})
        })
        .collect();
    json!({"ok": true, "items": shown, "own": own, "projects": projects, "catalog": catalog::page(&items)})
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

/// `{own: <key>}` copies one of an agent's own, its definition and never a token; `{kind: "skill",
/// folder}`; `{kind: "skill", source, skill}` from Browse, its folder fetched from GitHub first;
/// `{kind: "server", name, url, client_id?}`; `{kind: "server", name, command, args, env}`, its
/// command shown and confirmed in the Add dialog first. New items start off [D2046], unless the
/// draft carries the user's pick, `on` and `scope` [D571]. Answers the new item's key.
fn add(data: &Path, mut v: Value) -> io::Result<String> {
    let (on, scope) = (v["on"] == true, v["scope"].clone());
    if let Some(source) = v["source"].as_str() {
        let folder = browse::fetch(data, source, &[str(&v["skill"])])?.remove(0);
        v = json!({"kind": "skill", "folder": folder});
    }
    if let Some(key) = v["own"].as_str() {
        let all = projects::list(data).unwrap_or_default();
        let o = (own(&library::items(data), &all).into_iter()).find(|o| o["key"] == key);
        let o = o.ok_or_else(|| refuse("That agent's entry is gone. Refresh and try again."))?;
        v = match o["kind"] == "skill" {
            true => json!({"kind": "skill", "folder": o["detail"]}),
            // Its env and headers stay behind: they may hold its token.
            false => json!({"kind": "server", "name": shown(str(&o["name"])), "url": o["url"],
                "command": o["command"], "args": o["args"]}),
        };
    }
    let mut items = library::items(data);
    let skill = v["kind"] == "skill";
    let name = match skill {
        true => Path::new(str(&v["folder"]))
            .file_name()
            .map(|n| n.to_string_lossy().to_string()),
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
    let saved = library::save(data, &items);
    if saved.is_err() {
        let _ = forget(data, &key, &name);
    }
    saved.map(|()| key)
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
    let set = key.strip_prefix("skillset:");
    let these: Vec<&mut Value> = (items.iter_mut())
        .filter(|i| i["key"] == key || set.is_some_and(|w| i["kind"] == "skill" && i["with"] == w))
        .collect();
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
