//! What the agents have on this machine, in the library as they have it [D721]: one at home on for
//! all projects, a project's own on for that project only. It follows their settings: a new one is
//! added, a changed one updated, one no agent has any more removed; its switch stays the user's.
//! Never a sign-in: no env, header or token is copied [D424].

use super::{folders_of, str};
use brigadier_core::library;
use brigadier_core::{adapters, projects};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// Its local part, read from the agents' files at once; how each new address signs in is asked
/// after (`ask`), outside the library's lock, so nothing waits on a server that doesn't answer.
pub(super) fn sync(data: &Path) -> io::Result<()> {
    let mut items = library::items(data);
    let all = projects::list(data).unwrap_or_default();
    let mine: Vec<Value> = (items.iter().filter(|i| i["found"].is_null()))
        .cloned()
        .collect();
    let removed = library::removed(data);
    let mut want: Vec<Value> = vec![];
    let mut authors: Vec<String> = vec![];
    for o in own(&mine, &all)
        .into_iter()
        .filter(|o| o["in_library"] != true)
    {
        let name = library::key_name(str(&o["name"]));
        if name.is_empty() {
            continue;
        }
        let key = format!("{}:{name}", str(&o["kind"]));
        // One the user removed stays out, wherever it's found, until it's added again.
        if removed.contains(&key) {
            continue;
        }
        // One of its name in several projects is one item, on in each.
        if let Some(w) = want.iter_mut().find(|w| w["key"] == key) {
            let places = w["found"].as_array_mut().expect("found is a list");
            if !places.contains(&o["place"]) {
                places.push(o["place"].clone());
            }
            continue;
        }
        let mut w = match o["kind"] == "skill" {
            true => {
                let md = Path::new(str(&o["detail"])).join("SKILL.md");
                let text = std::fs::read_to_string(md).unwrap_or_default();
                authors.push(author(&text));
                json!({"folder": o["detail"], "description": crate::relay::described(&text)})
            }
            false => {
                authors.push(String::new());
                json!({"url": o["url"], "command": o["command"], "args": o["args"]})
            }
        };
        (w["key"], w["kind"], w["name"]) = (key.into(), o["kind"].clone(), name.into());
        (w["found"], w["from"]) = (json!([o["place"]]), from(&o).into());
        // One from a project's own file (`.mcp.json`) is the repo's word, not the user's: it
        // starts off, and switching it on is their yes [D418].
        w["on"] = (o["enabled"] != false && o["repo"] != true).into();
        w["repo"] = (o["repo"] == true).then_some(true).into();
        want.push(w);
    }
    // Skills from one source are one skillset [D720]: two or more whose SKILL.md names the same
    // `metadata.author`, called by the word their names share, else by the author.
    for at in 0..want.len() {
        let a = &authors[at];
        let peers: Vec<&str> = (0..want.len())
            .filter(|j| !a.is_empty() && authors[*j] == *a)
            .map(|j| str(&want[j]["name"]))
            .collect();
        let word = peers
            .first()
            .and_then(|p| p.split('-').next())
            .unwrap_or("");
        let set = match peers.iter().all(|p| p.split('-').next() == Some(word)) {
            true => word.to_string(),
            false => a.clone(),
        };
        want[at]["set"] = (peers.len() > 1).then_some(set).into();
    }
    let before = items.clone();
    items.retain(|i| i["found"].is_null() || want.iter().any(|w| w["key"] == i["key"]));
    for mut w in want {
        match items.iter_mut().find(|i| i["key"] == w["key"]) {
            // The user's own of that name stays theirs.
            Some(i) if i["found"].is_null() => {}
            Some(i) => {
                // On in a place it wasn't found in before, too.
                let new = (w["found"].as_array().into_iter().flatten())
                    .filter(|p| !i["found"].as_array().is_some_and(|f| f.contains(p)));
                for p in new.cloned().collect::<Vec<_>>() {
                    if p == "" {
                        i["scope"] = json!({"all": true});
                    } else if let Some(l) = i["scope"]["projects"].as_array_mut() {
                        l.push(p);
                    }
                }
                w.as_object_mut().map(|m| m.remove("on"));
                for (k, v) in w.as_object().into_iter().flatten() {
                    i[k] = v.clone();
                }
            }
            None => {
                let places = w["found"].clone();
                w["scope"] = match places.as_array().is_some_and(|p| p.contains(&json!(""))) {
                    true => json!({"all": true}),
                    false => json!({ "projects": places }),
                };
                items.push(w);
            }
        }
    }
    if items != before {
        library::save(data, &items)?;
    }
    Ok(())
}

/// How each new address signs in, all asked at once, saved once they answer; one that doesn't
/// answer signs in none. One left unasked (Brigadier quit meanwhile) is asked at the next sync.
// shortcut: an unreachable one isn't asked again; upgrade if one turns out to need Brigadier's sign-in.
pub(super) fn ask(data: &Path) {
    let new =
        |i: &&Value| i["found"].is_array() && i["url"].is_string() && i.get("sign_in").is_none();
    let urls: Vec<String> = (library::items(data).iter().filter(new))
        .map(|i| str(&i["url"]).to_string())
        .collect();
    if urls.is_empty() {
        return;
    }
    let kinds: Vec<Value> = std::thread::scope(|s| {
        let asked: Vec<_> = (urls.iter())
            .map(|u| s.spawn(move || crate::signin::kind(u, false).ok().flatten()))
            .collect();
        asked
            .into_iter()
            .map(|a| a.join().ok().flatten().into())
            .collect()
    });
    let _one = super::LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Read again: the library may have changed while they were asked.
    let mut items = library::items(data);
    for (url, kind) in urls.iter().zip(kinds) {
        let same = |i: &&mut Value| new(&&**i) && i["url"] == url.as_str();
        if let Some(i) = items.iter_mut().find(same) {
            i["sign_in"] = kind;
        }
    }
    let _ = library::save(data, &items);
}

/// Whether a server is from a project's own file; one found only in projects and saved before
/// that was kept counts as one, till the next sync says.
pub(super) fn repo(i: &Value) -> bool {
    let projects_only = (i["found"].as_array()).is_some_and(|f| !f.contains(&json!("")));
    i["repo"] == true || i["kind"] == "server" && i.get("repo").is_none() && projects_only
}

/// A SKILL.md's `metadata.author`, where its maker signs it: "github-spec-kit".
fn author(text: &str) -> String {
    let front = text
        .strip_prefix("---")
        .and_then(|t| t.split("\n---").next());
    let mut lines = front.into_iter().flat_map(str::lines);
    lines.find(|l| l.trim_end() == "metadata:");
    let found = lines
        .take_while(|l| l.starts_with([' ', '\t']))
        .find_map(|l| l.trim().strip_prefix("author:"));
    found.map_or(String::new(), |a| {
        a.trim().trim_matches(['"', '\'']).to_string()
    })
}

/// Whether a listed skill is the user's own, in a folder: not one of an agent's plugin.
fn ours(k: &Value) -> bool {
    k["path"].is_string() && !str(&k["name"]).contains(':')
}

/// Whether a listed skill is the user's own of this name in the library.
pub(super) fn is(k: &Value, name: &str) -> bool {
    ours(k) && library::key_name(str(&k["name"])) == name
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
            .filter(|k| k["kind"] == "skill" && ours(k))
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
            .flat_map(|p| folders_of(p).into_iter().map(move |f| Some((p, f)))),
    );
    let mut all: Vec<Value> = vec![];
    for place in places {
        let (p, folder) = (place.as_ref().map(|(p, _)| *p), place.map(|(_, f)| f));
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
                let inside = |f: &std::path::PathBuf| Path::new(str(&o["source"])).starts_with(f);
                o["repo"] = (o["kind"] == "server" && folder.as_ref().is_some_and(inside)).into();
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
