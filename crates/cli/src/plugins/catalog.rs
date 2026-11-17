//! `plugins install <id> '<scope>'` and Browse's catalog [D566, D569, D572]: the services and
//! skills Brigadier offers, shipped with it, each with the library's key where it holds it. A
//! service installs with its own skills, on in the projects picked [D571].

use super::{add, browse, refuse, str};
use brigadier_core::library;
use serde_json::{Value, json};
use std::io;
use std::path::Path;
use std::sync::LazyLock;

static CATALOG: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(include_str!("catalog.json")).unwrap_or_default());

fn entries() -> impl Iterator<Item = &'static Value> {
    CATALOG["entries"].as_array().into_iter().flatten()
}

fn address(v: &Value) -> Option<String> {
    let (scheme, rest) = v.as_str()?.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let port = match scheme.as_str() {
        "http" => ":80",
        "https" => ":443",
        _ => return None,
    };
    let (host, path) = rest.split_at(rest.find(['/', '?', '#']).unwrap_or(rest.len()));
    let host = host.to_ascii_lowercase();
    let host = host.strip_suffix(port).unwrap_or(&host);
    let (path, tail) = path.split_at(path.find(['?', '#']).unwrap_or(path.len()));
    Some(format!(
        "{scheme}://{host}{}{tail}",
        path.trim_end_matches('/')
    ))
}

/// Whether a library item is this entry: a server at its address, a skill of its name.
fn is(item: &Value, e: &Value) -> bool {
    match e["kind"] == "server" {
        true => {
            item["kind"] == "server"
                && address(&item["url"]).is_some_and(|url| Some(url) == address(&e["url"]))
        }
        false => item["kind"] == "skill" && item["name"] == e["skill"],
    }
}

/// The entry an item is, or came with; null for one of the user's own.
pub(super) fn id(item: &Value) -> Value {
    match item["with"].is_string() {
        true => item["with"].clone(),
        false => entries()
            .find(|e| is(item, e))
            .map_or(Value::Null, |e| e["id"].clone()),
    }
}

/// The catalog, each entry with `installed`, the key of the library's item that is it.
pub(super) fn page(items: &[Value]) -> Value {
    let mut c = CATALOG.clone();
    for e in c["entries"].as_array_mut().into_iter().flatten() {
        let held = items.iter().find(|i| is(i, e));
        e["installed"] = held.map_or(Value::Null, |i| i["key"].clone());
        // A service that signs in only through the user's own app: its prefilled create link [D591].
        if let Some(app) = e["app"].as_object_mut()
            && let Some(mut m) = app.remove("manifest")
        {
            let port = crate::signin::PRESET_PORT;
            m["oauth_config"]["redirect_urls"] =
                json!([format!("http://localhost:{port}/callback")]);
            let link = format!("{}{}", str(&app["create"]), browse::enc(&m.to_string()));
            app.insert("link".into(), link.into());
        }
    }
    c
}

/// Adds entry `id`, on in `scope`: a skill fetched from its repo; a service's server, then its
/// skills (all fetched first, so one that can't be leaves nothing added), each `with` it; skills
/// the library already holds by name and an existing matching server are kept as they are, so a
/// partial install can be retried; one that signs in only through the user's own app takes its
/// `client` id [D591]. Answers the server's or skill's key.
pub(super) fn install(data: &Path, id: &str, scope: Value, client: &str) -> io::Result<String> {
    let e = (entries().find(|e| e["id"] == id))
        .ok_or_else(|| refuse("Brigadier doesn't offer that one."))?;
    let scope = super::scope_of(&scope)?;
    let client = client.trim();
    if e["app"].is_object() && client.is_empty() {
        return Err(refuse("Paste your app's Client ID first."));
    }
    let pick = |mut v: Value| {
        (v["on"], v["scope"]) = (true.into(), scope.clone());
        v
    };
    if e["kind"] == "skill" {
        return add(
            data,
            pick(json!({"source": e["source"], "skill": e["skill"]})),
        );
    }
    let held = library::items(data);
    let skills: Vec<&str> = (e["skills"].as_array().into_iter().flatten())
        .map(|s| str(&s["skill"]))
        .filter(|s| !held.iter().any(|i| i["kind"] == "skill" && i["name"] == *s))
        .collect();
    // An entry's skills are all from one repo (catalog.json).
    let source = str(&e["skills"][0]["source"]);
    let folders = match skills.is_empty() {
        true => vec![],
        false => browse::fetch(data, source, &skills)?,
    };
    // A server held without the user's app's id couldn't sign in: adding it says it's already there.
    let kept = |i: &&Value| is(i, e) && (client.is_empty() || i["client_id"] == client);
    let key = match held.iter().find(kept) {
        Some(server) => str(&server["key"]).to_string(),
        None => add(
            data,
            pick(json!({"kind": "server", "name": id, "url": e["url"], "client_id": client})),
        )?,
    };
    for folder in folders {
        add(
            data,
            pick(json!({"kind": "skill", "folder": folder, "with": id})),
        )?;
    }
    Ok(key)
}
