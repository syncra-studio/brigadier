//! The library [D2043, D2046]: `library/items.json`, each item with its switch and scope and no
//! secret, and `library/skills/<name>/` in the Agent Skills format; secrets in the one Keychain
//! item. A launch that isn't naked gets the items on for its project under `sessions/<id>/plugins/`.

pub mod secrets;

use crate::Spec;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// What a library server's name is given in every agent's config, so it never meets the user's own.
pub const PREFIX: &str = "b-";

pub fn dir(data: &Path) -> PathBuf {
    data.join("library")
}

/// Every item: `{key, kind: "server"|"skill", name, description, on, scope: {all}|{projects}}`, a
/// server's `url` or `command` and `args`, and the names of its `secrets`; unknown fields kept.
pub fn items(data: &Path) -> Vec<Value> {
    let bytes = fs::read(dir(data).join("items.json")).unwrap_or_default();
    let v: Value = serde_json::from_slice(&bytes).unwrap_or_default();
    v["items"].as_array().cloned().unwrap_or_default()
}

pub fn save(data: &Path, items: &[Value]) -> io::Result<()> {
    fs::create_dir_all(dir(data))?;
    let bytes = serde_json::to_vec_pretty(&json!({ "items": items }))?;
    crate::write_atomic(&dir(data).join("items.json"), &bytes)
}

/// Whether an item is on for a session in `project`: switched on, for all projects or chosen ones
/// [D2046 D727].
pub fn on(item: &Value, project: Option<&str>) -> bool {
    let chosen = item["scope"]["projects"].as_array();
    let here = project.is_some_and(|p| chosen.is_some_and(|l| l.iter().any(|x| x == p)));
    item["on"] == true && (item["scope"]["all"] == true || here)
}

/// A library server's name in an agent's config.
pub fn named(name: &str) -> String {
    format!("{PREFIX}{name}")
}

/// A library server's key from its name in an agent's config, as `plugins add` makes it.
pub fn key(server: &str) -> String {
    format!("server:{}", plain(server))
}

/// A server as the thread names it: a library one by its plain name ("Used Linear") [D176].
pub fn plain(server: &str) -> &str {
    server.strip_prefix(PREFIX).unwrap_or(server)
}

/// A server's URL, else its command line.
pub fn detail(s: &Value) -> String {
    s["url"].as_str().map(String::from).unwrap_or_else(|| {
        let args = (s["args"].as_array().into_iter().flatten()).filter_map(Value::as_str);
        let line = std::iter::once(s["command"].as_str().unwrap_or("")).chain(args);
        line.collect::<Vec<_>>().join(" ")
    })
}

/// Whether an agent's own server is this library one: by name, or by URL or command [D407].
pub fn same(own: &Value, item: &Value) -> bool {
    own["name"] == item["name"] || (!detail(own).is_empty() && detail(own) == detail(item))
}

/// A skill's folder: one found on this machine where the agent keeps it [D721], else the library's copy.
pub fn skill_dir(data: &Path, item: &Value) -> PathBuf {
    match item["folder"].as_str() {
        Some(f) => PathBuf::from(f),
        None => dir(data).join("skills").join(plain_str(&item["name"])),
    }
}

/// The library items on for `project`, a skill's folder as its `path`.
pub fn on_for(data: &Path, project: Option<&str>) -> Vec<Value> {
    let mut all: Vec<Value> = (items(data).into_iter())
        .filter(|i| on(i, project))
        .collect();
    for i in all.iter_mut().filter(|i| i["kind"] == "skill") {
        i["path"] = json!(skill_dir(data, i));
    }
    all
}

/// Each server's secrets as its `env`, from the Keychain item, read only where one has any.
pub fn with_secrets(data: &Path, all: &mut [Value]) {
    let secret = |i: &Value| i["secrets"].as_array().is_some_and(|s| !s.is_empty());
    if !all.iter().any(secret) {
        return;
    }
    // shortcut: a Keychain that can't be read starts the server without its secrets; it says why itself.
    let payload = secrets::read(data).unwrap_or_default();
    for i in all.iter_mut().filter(|i| secret(i)) {
        let mine = payload.get(i["key"].as_str().unwrap_or(""));
        i["env"] = mine.map_or(Value::Null, |v| v["env"].clone());
    }
}

fn plain_str(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

/// What a launch gets of the library [D2031, D2043].
pub struct Kit {
    /// `sessions/<id>/plugins`, beside the host's own files there.
    pub dir: PathBuf,
    /// Its folder of skill links, `.claude/skills` so an added folder takes it whole [D2044].
    pub skills: PathBuf,
    /// The skills linked there, by name.
    pub names: Vec<String>,
    /// Each server on: its item, a local one's `env` its secrets, a remote one's `to` and
    /// `headers` what the agent reaches it at and with.
    pub servers: Vec<Value>,
}

/// The library servers an agent is given, and the names of its own servers that go off for them
/// [D407]; a server only each agent signs in to yields to the agent's own copy [wave4 D2045].
pub fn split(servers: &[Value], own: &[Value]) -> (Vec<Value>, Vec<String>) {
    let (mut given, mut off) = (vec![], vec![]);
    for s in servers {
        let mine = own.iter().filter(|o| same(o, s));
        let names: Vec<String> = mine
            .filter_map(|o| o["name"].as_str().map(String::from))
            .collect();
        // One found on this machine too: the agent that has it keeps its own, env and sign-in [D721].
        if (s["sign_in"] == "cli" || s["found"].is_array()) && !names.is_empty() {
            continue;
        }
        off.extend(names);
        given.push(s.clone());
    }
    (given, off)
}

/// The library for a launch of `spec`, its skills linked by their plain names but those in
/// `skip` (the agent's own copy wins there, D415); None for a worker's or a reviewer's (naked,
/// D89, D307), the message writer's (not in the session's own folder), or nothing on.
pub fn kit(spec: &Spec, skip: &[String]) -> Option<Kit> {
    let data = crate::data_of(spec);
    if spec.naked || spec.dir != crate::session_dir(&data, &spec.id) {
        return None;
    }
    let dir = spec.dir.join("plugins");
    // Only its own files: the links go, never what they point at [D35].
    let _ = fs::remove_dir_all(dir.join(".claude"));
    let mut all = on_for(&data, spec.project.as_deref());
    if all.is_empty() {
        return None;
    }
    let skills = dir.join(".claude/skills");
    fs::create_dir_all(&skills).ok()?;
    let mut names = vec![];
    for k in all.iter().filter(|i| i["kind"] == "skill") {
        let name = plain_str(&k["name"]);
        if !skip.iter().any(|s| s == name)
            && std::os::unix::fs::symlink(plain_str(&k["path"]), skills.join(name)).is_ok()
        {
            names.push(name.to_string());
        }
    }
    // A remote server goes through this session's proxy, which holds its sign-in or key; one only
    // each agent signs in to goes as it is [wave4 D2043, D2045]. No proxy, none of them.
    let proxy: Value = fs::read(dir.join("proxy.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    all.retain_mut(|i| {
        let Some(url) = i["url"].as_str().map(String::from) else {
            return true;
        };
        (i["to"], i["headers"]) = match (i["sign_in"] == "cli", proxy["port"].as_u64()) {
            (true, _) => (url.into(), json!({})),
            (false, Some(port)) => (
                format!(
                    "http://127.0.0.1:{port}/mcp/{}",
                    named(plain_str(&i["name"]))
                )
                .into(),
                json!({"Authorization": format!("Bearer {}", plain_str(&proxy["secret"]))}),
            ),
            (false, None) => return false,
        };
        true
    });
    with_secrets(&data, &mut all);
    let servers = all.into_iter().filter(|i| i["kind"] == "server");
    Some(Kit {
        dir,
        skills,
        names,
        servers: servers.collect(),
    })
}
