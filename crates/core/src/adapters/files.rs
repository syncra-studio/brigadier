//! Reading and trimming the files a CLI keeps for itself.

use super::{Done, Event, Tool};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// A one-question PendingQuestion (D177) from a CLI that asks one at a time.
pub fn question(id: &str, text: &str, options: &[String]) -> super::Event {
    let options: Vec<Value> = options.iter().map(|o| json!({"label": o})).collect();
    super::Event::Question(json!({"id": id, "title": null, "items": [
        {"text": text, "options": options, "recommended": null, "multiSelect": false}]}))
}

/// The skills a CLI keeps as `<folder>/<name>/SKILL.md`, each named with its folder's prefix (a
/// plugin's `plugin:`), by name once, the first folder's first [D100], the others' files its `also`.
pub fn skills_in(folders: impl IntoIterator<Item = (PathBuf, String)>) -> Vec<Value> {
    let mut list: Vec<Value> = vec![];
    for (folder, prefix) in folders {
        let mut found: Vec<(String, PathBuf)> = (std::fs::read_dir(&folder).into_iter().flatten())
            .flatten()
            .map(|e| {
                (
                    e.file_name().to_string_lossy().to_string(),
                    e.path().join("SKILL.md"),
                )
            })
            .filter(|(_, path)| path.is_file())
            .collect();
        found.sort();
        for (name, path) in found {
            let name = format!("{prefix}{name}");
            match list.iter_mut().find(|l| l["name"] == *name) {
                Some(first) => match first["also"].as_array_mut() {
                    Some(also) => also.push(json!(path)),
                    None => first["also"] = json!([path]),
                },
                None => list.push(json!({"name": name, "description": "", "kind": "skill", "path": path, "instant": false})),
            }
        }
    }
    list
}

/// A plugin's MCP servers: its `.mcp.json`'s and those its manifest names, inline or in a file,
/// each named `plugin:<plugin>:<server>` with the plugin as its `source`, and `var`, where its CLI
/// has one, in its values standing for its root [D565].
pub fn plugin_servers(root: &Path, manifest: &str, key: &str, var: Option<&str>) -> Vec<Value> {
    let read = |p: &Path| -> Value {
        serde_json::from_slice(&std::fs::read(p).unwrap_or_default()).unwrap_or_default()
    };
    // Its manifest's, after its `.mcp.json`'s and replacing them: a file, servers, or a list of both.
    let named = read(&root.join(manifest))["mcpServers"].clone();
    let named = match named {
        Value::Array(all) => all,
        one => vec![one],
    };
    let files = std::iter::once(read(&root.join(".mcp.json"))).chain(named.into_iter().map(|n| {
        match n.as_str() {
            Some(file) => read(&root.join(file)),
            None => n,
        }
    }));
    let (plugin, at) = (
        key.split('@').next().unwrap_or(key),
        root.display().to_string(),
    );
    let mut all: Vec<Value> = vec![];
    for file in files {
        let servers = file.get("mcpServers").unwrap_or(&file).as_object().cloned();
        for (name, d) in servers.into_iter().flatten() {
            let name = format!("plugin:{plugin}:{name}");
            let text = var.map_or(d.to_string(), |v| d.to_string().replace(v, &at));
            let mut d: Value = serde_json::from_str(&text).unwrap_or_default();
            (d["name"], d["source"]) = (name.as_str().into(), format!("plugin {key}").into());
            all.retain(|s| s["name"] != *name);
            all.push(d);
        }
    }
    all
}

/// A random UUID (v4), for a conversation id the CLI lets us pick.
pub fn uuid() -> String {
    let mut b = [0u8; 16];
    let _ = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut b));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    dashed(&h)
}

/// A command id as a UUID (v5's shape, from its SHA-1), for an agent that names an input only by
/// a UUID it was given: the same id gives the same UUID, in every build.
pub fn uuid_of(cid: &str) -> String {
    let mut h = sha1(cid.as_bytes())[..32].to_string();
    let variant = 8 | (u8::from_str_radix(&h[16..17], 16).unwrap_or(0) & 3);
    h.replace_range(12..13, "5");
    h.replace_range(16..17, &format!("{variant:x}"));
    dashed(&h)
}

fn dashed(h: &str) -> String {
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

/// Removes the lines of a CLI's shared JSON-lines file whose `key` is `id` [D35]. Other lines,
/// also ones the CLI appends meanwhile, stay: the swap happens only if the file didn't change
/// since it was read, else it reads again.
pub fn drop_lines(path: &Path, key: &str, id: &str) -> std::io::Result<usize> {
    for _ in 0..20 {
        let (before, perms) = match std::fs::metadata(path) {
            Ok(m) => ((m.len(), m.modified()?), m.permissions()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e),
        };
        let text = std::fs::read(path)?;
        let mine = |l: &[u8]| serde_json::from_slice::<Value>(l).is_ok_and(|v| v[key] == id);
        let lines: Vec<&[u8]> = text.split_inclusive(|&b| b == b'\n').collect();
        let gone = lines.iter().filter(|l| mine(l)).count();
        if gone == 0 {
            return Ok(0);
        }
        let kept: Vec<u8> = lines
            .into_iter()
            .filter(|l| !mine(l))
            .flatten()
            .copied()
            .collect();
        // Its own name per call, so two deletes at once never write the same temp file.
        let tmp = path.with_extension(format!("brigadier-{}", uuid()));
        std::fs::write(&tmp, kept)?;
        std::fs::set_permissions(&tmp, perms)?;
        let now = std::fs::metadata(path)?;
        // shortcut: an append landing between this check and the rename is lost; a lock the CLIs
        // share would close that, if they ever publish one.
        if (now.len(), now.modified()?) == before {
            std::fs::rename(&tmp, path)?;
            return Ok(gone);
        }
        std::fs::remove_file(&tmp)?;
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Err(std::io::Error::other(format!(
        "{} kept changing",
        path.display()
    )))
}

/// One changed file in the thread's FileChange shape [D74, D83]: what the CLI didn't report is null.
pub fn change(
    path: &str,
    change: &str,
    diff: Option<String>,
    added: Option<u64>,
    removed: Option<u64>,
) -> Value {
    let diff = diff.map(|d| hunks(&d)).filter(|d| !d.is_empty());
    serde_json::json!({"path": path, "change": change, "from": null, "diff": diff, "added": added, "removed": removed})
}

/// A unified diff's hunks alone: the file headers (`Index:`, `===`, `---`, `+++`) dropped.
fn hunks(diff: &str) -> String {
    let mut hunk = false;
    let mut out = String::new();
    for line in diff.lines() {
        if line.starts_with("@@") {
            hunk = true;
        } else if line.starts_with("diff ") || line.starts_with("Index: ") {
            hunk = false;
        }
        if hunk {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Lines added and removed in a unified diff: only lines inside hunks, so file headers don't count
/// and a `+++counter` line does.
pub fn counts(diff: &str) -> (u64, u64) {
    let (mut added, mut removed, mut hunk) = (0, 0, false);
    for line in diff.lines() {
        if line.starts_with("@@") {
            hunk = true;
        } else if line.starts_with("diff ") || line.starts_with("Index: ") {
            hunk = false;
        } else if hunk && line.starts_with('+') {
            added += 1;
        } else if hunk && line.starts_with('-') {
            removed += 1;
        }
    }
    (added, removed)
}

/// SHA-1 in hex (FIPS 180-4), for a CLI that names a folder by the hash of a path.
pub fn sha1(data: &[u8]) -> String {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut m = data.to_vec();
    m.push(0x80);
    while m.len() % 64 != 56 {
        m.push(0);
    }
    m.extend((data.len() as u64 * 8).to_be_bytes());
    for block in m.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..80 {
            w[i] = match i {
                0..16 => u32::from_be_bytes(block[4 * i..4 * i + 4].try_into().unwrap()),
                _ => (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1),
            };
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..20 => ((b & c) | (!b & d), 0x5A827999),
                20..40 => (b ^ c ^ d, 0x6ED9EBA1),
                40..60 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let t = (a.rotate_left(5))
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            (e, d, c, b, a) = (d, c, b.rotate_left(30), a, t);
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e]) {
            *x = x.wrapping_add(y);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

/// What a deny tells the agent: who denied it, the user or the session that started this worker
/// (`by: parent`), or Brigadier in a night, with their reason when they gave one [D192, D131].
pub fn denied(msg: &Value) -> String {
    let who = match msg["by"].as_str() {
        Some("parent") => "The session that started you",
        Some("overnight") => "Brigadier",
        _ => "The user",
    };
    match msg["reason"].as_str().unwrap_or("").trim() {
        "" => format!("{who} denied this."),
        why => format!("{who} denied this: {why}"),
    }
}

/// A job the user stopped from the card, said plainly, for an agent whose CLI has no channel of its
/// own to hear it: else it reads an unexplained kill and may start it again [D117].
pub fn stopped(msg: &Value) -> String {
    let what =
        (msg["command"].as_str()).map_or("a background process".into(), |c| format!("`{c}`"));
    format!(
        "The user stopped {what} themselves, from Brigadier. Leave it stopped: don't start it again."
    )
}

/// A subagent's own events as steps under its call `parent`, for its side panel: only its steps,
/// never its words or its to-dos [D115].
pub fn under(events: &mut Vec<Event>, parent: &str) {
    events.retain_mut(|e| match e {
        Event::ToolStart(Tool { parent: p, .. }) | Event::ToolEnd(Done { parent: p, .. }) => {
            *p = Some(parent.into());
            true
        }
        _ => false,
    });
}

/// A URL query value or path, percent-encoded but for URL-safe characters and `/`.
pub fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Whether a session grant is for this exact command in this folder, as Codex keys its own cache:
/// such a repeat is answered without asking the user [D193, D247, D389].
pub fn repeat(g: &Value, command: &Value, cwd: &Value) -> bool {
    // An unknown folder never matches: the user is asked again [D391].
    let folder = !cwd.is_null() && g["cli"]["cwd"] == *cwd;
    g["grant"]["scope"] == "command" && g["grant"]["pattern"] == *command && folder
}
