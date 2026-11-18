//! `plugins browse server|skill <query>` [D434, D435]: the Official MCP Registry's servers and
//! skills.sh's skills, each with what Add is filled in with; and a skill's folder fetched from its
//! GitHub repo for `add`. Rust makes every request; the page never fetches.

use super::{plain, refuse, str};
use brigadier_core::adapters::setup;
use brigadier_core::library;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// A skill fetched for the library: at most this many bytes and files [D436].
const MAX_BYTES: u64 = 10 << 20;
const MAX_FILES: usize = 200;

/// A row's icon: at most this many bytes, waited for this many seconds [D660].
const ICON_BYTES: u64 = 64 << 10;
const ICON_SECS: u64 = 5;

/// One GET through the system's curl, as the rest of Brigadier's requests; `max` bytes at most.
fn get(url: &str, max: u64, secs: u64) -> Result<Vec<u8>, String> {
    let mut c = Command::new("/usr/bin/curl");
    c.args([
        "-sSfL",
        "--max-time",
        &secs.to_string(),
        "--max-filesize",
        &max.to_string(),
    ])
    .args(["--", url]);
    let out = setup::run(&mut c, secs + 5)?;
    match out.status.success() {
        true => Ok(out.stdout),
        false => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
    }
}

pub(super) fn enc(s: &str) -> String {
    let keep = |b: u8| b.is_ascii_alphanumeric() || b"-._~".contains(&b);
    (s.bytes())
        .map(|b| match keep(b) {
            true => (b as char).to_string(),
            false => format!("%{b:02X}"),
        })
        .collect()
}

pub(super) fn run(data: &Path, kind: &str, query: &str) -> io::Result<Value> {
    let lib = library::items(data);
    let mut found: Vec<Value> = match kind {
        // shortcut: live registry query per search, upgrade to a cached copy (updated_since) if it rate-limits or changes.
        "server" => {
            let url = format!(
                "https://registry.modelcontextprotocol.io/v0.1/servers?search={}&version=latest&limit=30",
                enc(query)
            );
            let page = reach(&url, "the MCP Registry")?;
            (page["servers"].as_array().into_iter().flatten())
                .map(|s| server(&s["server"], &lib))
                .collect::<Vec<_>>()
        }
        // shortcut: live query per search of skills.sh's undocumented /api/search, upgrade to its documented API or a cached copy if it rate-limits or changes.
        "skill" => {
            let url = format!("https://skills.sh/api/search?q={}&limit=30", enc(query));
            let page = reach(&url, "skills.sh")?;
            (page["skills"].as_array().into_iter().flatten())
                .map(|s| skill(s, &lib))
                .collect()
        }
        _ => {
            return Err(refuse(
                "usage: brigadier plugins browse server|skill <query>",
            ));
        }
    };
    // Every row's icon at once, so a search waits for the slowest one only.
    std::thread::scope(|scope| {
        for row in &mut found {
            scope.spawn(move || {
                let from = row["icon"].take();
                let urls = from
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str);
                row["icon"] = urls.into_iter().find_map(|url| icon(data, url)).into();
            });
        }
    });
    Ok(json!({"ok": true, "found": found}))
}

/// An image at `url` as a data URL, the page's only way to show one (its CSP); each kept in the
/// data folder, a miss too, so it's asked for once.
// shortcut: the cache never expires; upgrade to a dated one if makers change their icons often.
fn icon(data: &Path, url: &str) -> Option<String> {
    let key: String = (Sha256::digest(url.as_bytes()).iter())
        .map(|b| format!("{b:02x}"))
        .collect();
    let file = data.join("plugins").join("icons").join(key);
    let bytes = fs::read(&file).unwrap_or_else(|_| {
        let got = get(url, ICON_BYTES, ICON_SECS).unwrap_or_default();
        let got = if image(&got).is_some() { got } else { vec![] };
        let _ = fs::create_dir_all(data.join("plugins").join("icons"));
        let _ = fs::write(&file, &got);
        got
    });
    let kind = image(&bytes)?;
    Some(format!(
        "data:{kind};base64,{}",
        brigadier_frames::base64(&bytes)
    ))
}

/// What image these bytes are, by their first bytes; None for a page or anything else.
fn image(b: &[u8]) -> Option<&'static str> {
    let head = String::from_utf8_lossy(&b[..b.len().min(512)]).to_ascii_lowercase();
    match b {
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xFF, 0xD8, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', ..] => Some("image/gif"),
        [0, 0, 1, 0, ..] => Some("image/x-icon"),
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => Some("image/webp"),
        _ if head.contains("<svg") && !head.contains("<html") => Some("image/svg+xml"),
        _ => None,
    }
}

/// Where a registry server's icon may come from: the icons it lists, then its proven namespace's
/// (a GitHub account's avatar, a domain's favicon).
fn server_icons(s: &Value) -> Vec<String> {
    let listed = (s["icons"].as_array().into_iter().flatten())
        .filter_map(|i| i["src"].as_str())
        .filter(|src| src.starts_with("https://"))
        .map(String::from);
    let ns = str(&s["name"]).split('/').next().unwrap_or("");
    let proven = match ns.strip_prefix("io.github.") {
        Some(user) => avatar(user),
        None if ns.contains('.') => Some(format!(
            "https://{}/favicon.ico",
            ns.rsplit('.').collect::<Vec<_>>().join(".")
        )),
        None => None,
    };
    listed.chain(proven).collect()
}

/// A GitHub account's avatar, small.
fn avatar(user: &str) -> Option<String> {
    let ok = !user.is_empty() && user.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    ok.then(|| format!("https://github.com/{user}.png?size=64"))
}

fn reach(url: &str, source: &str) -> io::Result<Value> {
    let said = || {
        refuse(&format!(
            "Couldn't reach {source}. Check your connection and try again."
        ))
    };
    let bytes = get(url, 8 << 20, 20).map_err(|_| said())?;
    serde_json::from_slice(&bytes).map_err(|_| said())
}

/// A library name from a registry name's last part: "io.github.x/Linear MCP" → "linear-mcp".
fn named(name: &str) -> String {
    let last = name.rsplit('/').next().unwrap_or(name).to_ascii_lowercase();
    let dashed: String = (last.chars())
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let parts: Vec<&str> = dashed.split('-').filter(|p| !p.is_empty()).collect();
    parts.join("-").chars().take(64).collect()
}

/// The namespace the registry proved: a GitHub account, or a domain read the right way round.
fn publisher(name: &str) -> String {
    let ns = name.split('/').next().unwrap_or("");
    match ns.strip_prefix("io.github.") {
        Some(user) => format!("GitHub: {user}"),
        None => ns.rsplit('.').collect::<Vec<_>>().join("."),
    }
}

/// The names of what it declares secret or required, required first; values are the user's.
fn names(list: &Value) -> Vec<Value> {
    let mut all: Vec<&Value> = (list.as_array().into_iter().flatten())
        .filter(|v| v["isSecret"] == true || v["isRequired"] == true)
        .collect();
    all.sort_by_key(|v| v["isRequired"] != true);
    all.iter().map(|v| v["name"].clone()).collect()
}

/// A registry entry as a row: at an address where it has one, else its package pinned to its
/// version; one Brigadier can't run is shown with why.
fn server(s: &Value, lib: &[Value]) -> Value {
    let name = named(str(&s["name"]));
    let remotes = s["remotes"].as_array().cloned().unwrap_or_default();
    let packages = s["packages"].as_array().cloned().unwrap_or_default();
    let remote = remotes.iter().find(|r| r["type"] == "streamable-http");
    let package = packages.iter().find_map(|p| Some((p, command(p)?)));
    let (how, mark, form, why) = if let Some(r) = remote {
        let url = str(&r["url"]);
        let host = url.split("://").nth(1).and_then(|u| u.split('/').next());
        let form =
            json!({"remote": true, "name": name, "url": url, "values": names(&r["headers"])});
        (
            "At an address".to_string(),
            host.unwrap_or(""),
            Some(form),
            None,
        )
    } else if let Some((p, line)) = package {
        let form = json!({"remote": false, "name": name, "command": line,
            "values": names(&p["environmentVariables"])});
        (
            format!("{}, runs on this computer", kind(&p["registryType"])),
            str(&p["identifier"]),
            Some(form),
            None,
        )
    } else {
        let why = match (remotes.first(), packages.first()) {
            (Some(_), _) => "It's reached over SSE, which Brigadier doesn't connect to yet.".into(),
            (_, Some(p)) if p["transport"]["type"] != "stdio" && !p["transport"].is_null() => {
                "Its package serves over HTTP, which Brigadier doesn't run yet.".into()
            }
            (_, Some(_)) => "Brigadier can't run these yet.".into(),
            _ => "It says neither an address nor a package.".to_string(),
        };
        let how = match packages.first() {
            Some(p) => kind(&p["registryType"]),
            None => "At an address".into(),
        };
        (how, "", None, Some(why))
    };
    let held = form.as_ref().is_some_and(|f| {
        let line: Vec<&str> = str(&f["command"]).split(' ').collect();
        let me = match f["remote"] == true {
            true => json!({"name": name, "url": f["url"]}),
            false => json!({"name": name, "command": line[0], "args": line[1..]}),
        };
        (lib.iter().filter(|i| i["kind"] == "server")).any(|i| library::same(&me, i))
    });
    json!({"key": s["name"], "kind": "server", "name": s["title"].as_str().unwrap_or(str(&s["name"])),
        "description": s["description"], "publisher": publisher(str(&s["name"])), "how": how,
        "catalog": super::catalog::id(&json!({"kind": "server", "url": form.as_ref().map(|f| &f["url"])})),
        "mark": mark, "icon": server_icons(s), "in_library": held, "form": form, "why": why})
}

#[test]
fn registry_server_catalog_address() {
    for (url, expected) in [
        ("https://mcp.linear.app/mcp", Some("linear")),
        ("HTTPS://MCP.LINEAR.APP:443/mcp///", Some("linear")),
        ("https://mcp.linear.app/other", None),
        ("https://mcp.linear.app/mcp?other=1", None),
        ("https://mcp.linear.app.evil.example/mcp", None),
        ("not a url", None),
    ] {
        let found = server(
            &json!({"name": "app.linear/linear", "remotes": [{"type": "streamable-http", "url": url}]}),
            &[],
        );
        assert_eq!(found["catalog"], json!(expected), "{url}");
    }
}

/// A stdio package as its version-pinned command line, and what it is; None for one Brigadier
/// can't start (dnx and mcpb come later).
fn command(p: &Value) -> Option<String> {
    if !(p["transport"]["type"] == "stdio" || p["transport"].is_null()) {
        return None;
    }
    let (id, ver) = (str(&p["identifier"]), str(&p["version"]));
    let pin = |sep: &str| match ver.is_empty() {
        true => id.to_string(),
        false => format!("{id}{sep}{ver}"),
    };
    // shortcut: a package's declared arguments aren't added; the user types them into Add's command.
    match str(&p["registryType"]) {
        "npm" => Some(format!("npx -y {}", pin("@"))),
        "pypi" => Some(format!("uvx {}", pin("=="))),
        "oci" => {
            // Newer entries carry the tag in the identifier.
            let tagged = id
                .rsplit('/')
                .next()
                .is_some_and(|l| l.contains([':', '@']));
            let image = if tagged { id.to_string() } else { pin(":") };
            let env = names(&p["environmentVariables"]);
            let env: String = (env.iter()).map(|n| format!("-e {} ", str(n))).collect();
            Some(format!("docker run -i --rm {env}{image}"))
        }
        _ => None,
    }
}

/// What a registry type is, in words.
fn kind(t: &Value) -> String {
    match str(t) {
        "npm" => "npm package".into(),
        "pypi" => "Python package".into(),
        "oci" => "Docker image".into(),
        "nuget" => "NuGet package".into(),
        "mcpb" => "MCP bundle".into(),
        t => format!("{t} package"),
    }
}

fn installs(n: u64) -> String {
    match n {
        0..1000 => format!("{n} installs"),
        1000..1_000_000 => format!("{}k installs", n / 1000),
        _ => format!("{:.1}M installs", n as f64 / 1e6),
    }
}

/// A skills.sh skill as a row; Add fetches its folder from its GitHub repo.
fn skill(s: &Value, lib: &[Value]) -> Value {
    let (source, id) = (str(&s["source"]), str(&s["skillId"]));
    let why = match (repo(source), plain(id)) {
        (false, _) => {
            Some("It isn't in a GitHub repo, which is where Brigadier copies skills from.")
        }
        (_, Err(_)) => Some("Its name has letters a library name can't hold."),
        _ => None,
    };
    let held = (lib.iter()).any(|i| i["kind"] == "skill" && i["name"] == id);
    json!({"key": s["id"], "kind": "skill", "name": id, "description": "", "publisher": source,
        "how": installs(s["installs"].as_u64().unwrap_or(0)), "mark": "", "in_library": held,
        "icon": avatar(source.split('/').next().unwrap_or("")).into_iter().collect::<Vec<_>>(),
        "form": why.is_none().then(|| json!({"source": source, "skill": id})), "why": why})
}

/// "owner/repo", as GitHub names them.
fn repo(source: &str) -> bool {
    let part = |p: &str| {
        !p.is_empty()
            && !p.starts_with('.')
            && (p.chars()).all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    };
    matches!(source.split_once('/'), Some((o, r)) if part(o) && part(r) && !r.contains('/'))
}

/// Where a fetched skill waits for `add` to copy it in; gone after.
pub(super) fn incoming(data: &Path) -> PathBuf {
    library::dir(data).join(".incoming")
}

/// Each skill of `ids`, its folder from `source`'s default branch, into `incoming`: the folder named
/// after it holding a SKILL.md, else the repo's only SKILL.md. Every path is checked, links and
/// submodules refused, its size capped: this is the trust boundary [D436]. One commit and tree for
/// them all, so a catalog entry's skills cost two API requests.
pub(super) fn fetch(data: &Path, source: &str, ids: &[&str]) -> io::Result<Vec<PathBuf>> {
    for id in ids {
        plain(id)?;
    }
    if !repo(source) {
        return Err(refuse("Brigadier copies skills only from a GitHub repo."));
    }
    let gone = || {
        refuse(&format!(
            "Couldn't reach GitHub for {}. Check your connection and try again.",
            ids.join(", ")
        ))
    };
    // shortcut: GitHub's API without a token allows 60 requests an hour; two per fetch.
    let api = |path: &str| -> io::Result<Value> {
        let bytes = get(
            &format!("https://api.github.com/repos/{source}/{path}"),
            32 << 20,
            20,
        );
        serde_json::from_slice(&bytes.map_err(|_| gone())?).map_err(|_| gone())
    };
    // One commit for the tree and every file, so what was checked is what's copied.
    let commit = api("commits/HEAD")?;
    let sha = str(&commit["sha"]);
    if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(gone());
    }
    let raw = |path: &str, max: u64| {
        let path = (path.split('/')).map(enc).collect::<Vec<_>>().join("/");
        get(
            &format!("https://raw.githubusercontent.com/{source}/{sha}/{path}"),
            max,
            20,
        )
        .map_err(|_| gone())
    };
    let all = api(&format!("git/trees/{sha}?recursive=1"))?["tree"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let dirs: Vec<&str> = (all.iter())
        .filter_map(|e| str(&e["path"]).strip_suffix("SKILL.md"))
        .filter(|d| d.is_empty() || d.ends_with('/'))
        .collect();
    let _ = fs::remove_dir_all(incoming(data));
    let mut fetched = vec![];
    for id in ids {
        fetched.push(copy(data, id, source, &all, &dirs, &raw)?);
    }
    Ok(fetched)
}

/// One skill's folder of the fetched tree, into `incoming`.
fn copy(
    data: &Path,
    id: &str,
    source: &str,
    all: &[Value],
    dirs: &[&str],
    raw: &dyn Fn(&str, u64) -> io::Result<Vec<u8>>,
) -> io::Result<PathBuf> {
    // The folder named after it, the repo's only skill, else the one whose SKILL.md declares its name.
    let named = (dirs.iter()).find(|d| d.trim_end_matches('/').rsplit('/').next() == Some(id));
    let only = (dirs.len() == 1).then(|| &dirs[0]);
    let declared = || {
        (dirs.iter().take(50)).find(|d| {
            let text = raw(&format!("{d}SKILL.md"), 1 << 20).unwrap_or_default();
            declared(&String::from_utf8_lossy(&text)).as_deref() == Some(id)
        })
    };
    let dir = (named.or(only).or_else(declared))
        .ok_or_else(|| refuse(&format!("Couldn't find {id} in {source}.")))?;
    let files: Vec<&Value> = (all.iter())
        .filter(|e| e["type"] != "tree" && str(&e["path"]).starts_with(*dir))
        .collect();
    let size: u64 = files.iter().filter_map(|e| e["size"].as_u64()).sum();
    let big = || {
        refuse(&format!(
            "{id} is larger than Brigadier copies (10 MB, 200 files)."
        ))
    };
    if files.len() > MAX_FILES || size > MAX_BYTES {
        return Err(big());
    }
    let to = incoming(data).join(id);
    fs::create_dir_all(&to)?;
    let mut left = MAX_BYTES;
    for e in files {
        let path = str(&e["path"]);
        let rel = &path[dir.len()..];
        let safe =
            (rel.split('/')).all(|p| !p.is_empty() && p != "." && p != ".." && !p.contains('\\'));
        if e["type"] != "blob" || e["mode"] == "120000" || !safe {
            return Err(refuse(&format!(
                "{id} holds links or paths Brigadier won't copy."
            )));
        }
        let bytes = raw(path, left)?;
        left = left.checked_sub(bytes.len() as u64).ok_or_else(big)?;
        let file = to.join(rel);
        fs::create_dir_all(file.parent().unwrap_or(&to))?;
        fs::write(&file, bytes)?;
        if e["mode"] == "100755" {
            fs::set_permissions(&file, fs::Permissions::from_mode(0o755))?;
        }
    }
    Ok(to)
}

/// The `name:` a SKILL.md's front matter declares.
fn declared(text: &str) -> Option<String> {
    let front = text.strip_prefix("---")?.split("\n---").next()?;
    let name = front.lines().find_map(|l| l.strip_prefix("name:"))?;
    Some(name.trim().trim_matches(['"', '\'']).to_string())
}
