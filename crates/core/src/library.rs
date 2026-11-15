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

/// Whether an item is on for a session in `project`: off until switched on, for all projects or
/// chosen ones [D2046].
pub fn on(item: &Value, project: Option<&str>) -> bool {
    let chosen = item["scope"]["projects"].as_array();
    let here = project.is_some_and(|p| chosen.is_some_and(|l| l.iter().any(|x| x == p)));
    item["on"] == true && (item["scope"]["all"] == true || here)
}

/// A library server's name in an agent's config.
pub fn named(name: &str) -> String {
    format!("{PREFIX}{name}")
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

/// The library items on for `project`, a skill's folder as its `path`.
pub fn on_for(data: &Path, project: Option<&str>) -> Vec<Value> {
    let mut all: Vec<Value> = (items(data).into_iter())
        .filter(|i| on(i, project))
        .collect();
    for i in all.iter_mut().filter(|i| i["kind"] == "skill") {
        i["path"] = json!(dir(data).join("skills").join(plain_str(&i["name"])));
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
    /// Each local server on: its item, `env` its secrets.
    pub servers: Vec<Value>,
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
    // shortcut: a remote server waits for 4.13's proxy; only local ones are passed.
    all.retain(|i| i["kind"] == "skill" || i["command"].is_string());
    with_secrets(&data, &mut all);
    let servers = all.into_iter().filter(|i| i["kind"] == "server");
    Some(Kit {
        dir,
        skills,
        names,
        servers: servers.collect(),
    })
}
