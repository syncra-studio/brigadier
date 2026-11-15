//! `plugins [add '<json>' | set <key> '<json>' | remove <key>]`: Settings › Plugins [D2043, D2046].
//! Each prints the library's items, each agent's own (read only) and the projects.

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
    let _one = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match arg(1) {
        "" => {}
        "add" => add(data, json(2)?)?,
        "set" => set(data, arg(2), json(3)?)?,
        "remove" => remove(data, arg(2))?,
        _ => {
            return Err(io::Error::other(
                "usage: brigadier plugins [add '<json>' | set <key> '<json>' | remove <key>]",
            ));
        }
    }
    Ok(list(data))
}

/// A skill's folder and name, a server's URL or command; `in_library` where the library holds one
/// of its name, URL or command.
fn own(lib: &[Value]) -> Vec<Value> {
    let home = adapters::home_path("");
    let mut all: Vec<Value> = vec![];
    for a in crate::setup::available() {
        let skills = (a.fixed_commands(None, None).into_iter())
            .filter(|k| {
                k["kind"] == "skill" && k["path"].is_string() && !str(&k["name"]).contains(':')
            })
            .map(|k| {
                let folder = Path::new(str(&k["path"])).parent().map(Path::to_path_buf);
                json!({"kind": "skill", "name": k["name"], "detail": folder})
            });
        let servers = (a.mcp_servers(&home).into_iter()).map(|mut s| {
            s["kind"] = "server".into();
            s["detail"] = library::detail(&s).into();
            s
        });
        for mut o in skills.chain(servers) {
            let key = format!("own:{}:{}:{}", a.name(), str(&o["kind"]), str(&o["name"]));
            if all.iter().any(|x| x["key"] == *key) {
                continue;
            }
            let held = |i: &&Value| i["kind"] == o["kind"];
            o["in_library"] = (lib.iter().filter(held)).any(|i| same(&o, i)).into();
            (o["key"], o["agent"]) = (key.into(), a.label().into());
            all.push(o);
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

fn str(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn list(data: &Path) -> Value {
    let items = library::items(data);
    // Only what the page draws: an own server's env and headers may hold its token.
    let own: Vec<Value> = (own(&items).into_iter())
        .map(|o| {
            json!({"key": o["key"], "kind": o["kind"], "name": o["name"], "detail": o["detail"],
            "agent": o["agent"], "in_library": o["in_library"]})
        })
        .collect();
    let agents: Vec<_> = crate::setup::available().into_iter().collect();
    let all = projects::list(data).unwrap_or_default();
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
            let note = (!kept.is_empty()).then(|| {
                format!("{} uses your own copy of this skill.", kept.join(" and "))
            });
            json!({"key": i["key"], "kind": i["kind"], "name": i["name"], "description": i["description"],
                "detail": detail, "on": i["on"] == true, "scope": i["scope"], "status": i.get("status"),
                "sign_in": i.get("sign_in"), "signed_in": i.get("signed_in"), "agents": agents.iter().map(|a| a.label()).collect::<Vec<_>>(),
                "note": note})
        })
        .collect();
    json!({"ok": true, "items": shown, "own": own, "projects": projects})
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
/// folder}`; `{kind: "server", name, url}`; `{kind: "server", name, command, args, env}`, its
/// command shown and confirmed in the Add dialog first. New items start off [D2046].
fn add(data: &Path, mut v: Value) -> io::Result<()> {
    if let Some(key) = v["own"].as_str() {
        let o = (own(&library::items(data)).into_iter()).find(|o| o["key"] == key);
        let o = o.ok_or_else(|| refuse("That agent's entry is gone. Refresh and try again."))?;
        v = match o["kind"] == "skill" {
            true => json!({"kind": "skill", "folder": o["detail"]}),
            // Its env and headers stay behind: they may hold its token.
            false => json!({"kind": "server", "name": o["name"], "url": o["url"],
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
        "on": false, "scope": {"all": true}});
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
    saved
}

/// `{on?, scope?: {all: true} | {projects: [<id>]}}`.
fn set(data: &Path, key: &str, v: Value) -> io::Result<()> {
    let mut items = library::items(data);
    let item = (items.iter_mut()).find(|i| i["key"] == key);
    let item = item.ok_or_else(|| refuse("That item is no longer in the library."))?;
    if let Some(on) = v["on"].as_bool() {
        item["on"] = on.into();
    }
    match &v["scope"] {
        Value::Null => {}
        s if s["all"] == true => item["scope"] = json!({"all": true}),
        s if s["projects"]
            .as_array()
            .is_some_and(|p| p.iter().all(Value::is_string)) =>
        {
            item["scope"] = json!({"projects": s["projects"]})
        }
        _ => {
            return Err(refuse(
                "A scope is {\"all\": true} or {\"projects\": [ids]}.",
            ));
        }
    }
    library::save(data, &items)
}

fn remove(data: &Path, key: &str) -> io::Result<()> {
    let mut items = library::items(data);
    let Some(at) = items.iter().position(|i| i["key"] == key) else {
        return Ok(());
    };
    // Its folder and secrets first, so a failed cleanup stays listed to retry.
    forget(data, key, str(&items[at]["name"]))?;
    items.remove(at);
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
