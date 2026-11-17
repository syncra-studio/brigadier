//! The relay [D89, D100]: what a session's agent pulls through `brigadier` instead of loading it,
//! a naked worker's only way to them: the user's own skills, read only from each agent's own
//! folders, and past sessions.

pub(crate) mod mockup;
mod show;

use brigadier_core::{self as core, adapters};
use serde_json::{Value, json};
use std::path::Path;

type Spec = (
    &'static str,
    &'static [&'static str],
    &'static [&'static str],
);

/// Each relay command's help, its value flags and its plain flags.
pub fn spec(cmd: &str) -> Option<Spec> {
    Some(match cmd {
        "skill" => (
            "brigadier skill [<name>] [--json]\n\nThe user's skills: Brigadier's library for this project first, then every agent's own folders. With a name, prints that skill's SKILL.md whole and its folder; read its other files there yourself.",
            &[],
            &[],
        ),
        "search" => (
            "brigadier search \"<words>\" [--in <id>] [--from F] [--file <path>] [--json]

Every session's past, yours and archived ones too: the messages, tool calls and errors holding every
word, newest first, each under a reference like s-abc#123 that `brigadier read s-abc#123` opens.
--in keeps one session, --from one sender (user, agent, worker, peer, tool, error), --file the steps
that touched a file (words may then be left out). A newer message may revise an older one: read on.",
            &["--in", "--from", "--file"],
            &[],
        ),
        "mcp" => (
            "brigadier mcp list | tools <server> | call <server> <tool> ['<json>'] [--json]

The user's MCP servers: Brigadier's library for this project first, then every agent's own config,
the same on every agent: `list` names them, `tools <server>` lists its tools with their input
schemas, `call` runs one tool with the JSON object of its arguments (none: {}) and prints what it
answered. One connection per server is kept for you while you use it, so what a call opens stays
good for your next call. A library server uses Brigadier's one sign-in; one whose sign-in ended says
so, and the user signs in again in Brigadier (Settings › Plugins).",
            &[],
            &[],
        ),
        "show" => (
            "brigadier show <file>[:<line>] | <url> [--json]

Shows the user a file of your checkout in the file viewer, at its line, or a web page (http or https,
such as your dev server's) in a browser tab of your session, one already on that page reused. A
file:// or other address isn't shown: to show an .html file rendered, serve it and show its address.
A worker's tab opens behind; the user sees it in your session's tabs.",
            &[],
            &[],
        ),
        "repo" => (
            "brigadier repo <name> [--json]

This chat's project is a folder of git repos, each named on your map by its path in that folder.
Read and search repos where they are, but never change them there: before your first edit in a
repo, run `brigadier repo <name>`. It gives you your own copy of that repo on a branch of its own
and prints its folder; make every edit, command and commit in that folder. Run it again and you get
the same folder. Claim only a repo you are about to change, never one you are only looking at. A
worker's copy starts from its parent's branch in that repo, when the parent has one. A repo cloned
into the folder since this chat started is on the map from its next start.",
            &[],
            &[],
        ),
        "mockup" => (
            "brigadier mockup \"<what>\" [--reuse <session>] [--json]

Before a big UI change (a new screen, a redesign, a layout across screens) and never for a small fix,
offer the user a mockup on a card: Yes, 3 variants / Yes, just 1 / Skip. <what> is the change, in a
line the user reads. It waits up to 5 minutes and prints what the pick did. On Yes, a mockup worker
draws the variants from your repo's own components and the user compares them in the Mockup tab;
the variant they pick there is wired in by that worker, so don't build the change yourself. On Skip,
build it. --reuse <session>: another session already drew this change; the card offers its mockup.
A mockup worker reports each variant: --round N --variant A|B|C --name \"<name>\" --why \"<line>\"
--url <page> [--shot <png>], and --real <url> once the pick is wired in.",
            &["--reuse", "--round", "--variant", "--name", "--why", "--url", "--shot", "--real"],
            &[],
        ),
        _ => return None,
    })
}

/// `mcp`, its own words past the command: its help, or its reply as asked, JSON or capped text.
pub fn mcp(data: &Path, me: &str, args: &[String]) -> Value {
    let json = args.iter().any(|a| a == "--json");
    if args.iter().any(|a| a == "--help") {
        return json!({"ok": true, "text": spec("mcp").map_or("", |s| s.0)});
    }
    let words: Vec<&str> = (args.iter().skip(1))
        .map(String::as_str)
        .filter(|a| *a != "--json")
        .collect();
    let mut reply = crate::mcp::run(data, me, &words);
    if json {
        reply.as_object_mut().map(|o| o.remove("text"));
    } else if reply["ok"] == true {
        reply =
            json!({"ok": true, "text": crate::agent::cap(reply["text"].as_str().unwrap_or(""))});
    }
    reply
}

/// Runs a relay command, or None for another.
pub fn run(
    data: &Path,
    me: &str,
    cmd: &str,
    arg: Option<&str>,
    value: &dyn Fn(&str) -> Option<String>,
    rows: &[Value],
    here: &dyn Fn() -> bool,
) -> Option<Value> {
    match cmd {
        "mockup" => Some(mockup::run(data, me, arg, value, here)),
        "skill" => Some(skill(data, me, arg)),
        "search" => Some(search(data, arg.unwrap_or(""), value, rows)),
        "show" => Some(show::show(data, me, arg.unwrap_or(""))),
        "repo" => Some(
            core::load(data, me)
                .and_then(|spec| core::folder::claim(&spec, arg.unwrap_or("")))
                .map_or_else(
                    |e| json!({"ok": false, "error": e.to_string()}),
                    |text| json!({"ok": true, "text": text}),
                ),
        ),
        _ => None,
    }
}

/// The library's skills on for the caller's project, then those each agent keeps for its folder,
/// by name once: the library's, else the first agent's [D407].
fn skills(data: &Path, me: &str) -> Vec<Value> {
    let spec = core::load(data, me).ok();
    let project = spec.as_ref().and_then(|s| s.project.clone());
    let cwd = spec.map(|s| s.cwd).unwrap_or_default();
    let mut all: Vec<Value> = (core::library::on_for(data, project.as_deref()).into_iter())
        .filter(|i| i["kind"] == "skill")
        .map(|i| json!({"name": i["name"], "path": Path::new(i["path"].as_str().unwrap_or("")).join("SKILL.md")}))
        .collect();
    for a in adapters::all() {
        for k in a.fixed_commands(Some(Path::new(&cwd)), None) {
            if k["kind"] == "skill"
                && k["path"].is_string()
                && !all.iter().any(|x| x["name"] == k["name"])
            {
                all.push(k);
            }
        }
    }
    all
}

/// The `description:` of a SKILL.md's front matter, on one line; a `>` or `|` block's lines joined.
pub(crate) fn described(text: &str) -> String {
    let front = text
        .strip_prefix("---")
        .and_then(|t| t.split("\n---").next());
    let mut lines = front.into_iter().flat_map(str::lines);
    let Some(first) = lines.find_map(|l| l.strip_prefix("description:")) else {
        return String::new();
    };
    let first = first.trim();
    let d = match first.starts_with(['>', '|']) {
        true => (lines
            .take_while(|l| l.starts_with([' ', '\t']))
            .map(str::trim))
        .collect::<Vec<_>>()
        .join(" "),
        false => first.trim_matches(['"', '\'']).to_string(),
    };
    d.chars().take(200).collect()
}

/// `skill`: the list, or one whole.
fn skill(data: &Path, me: &str, name: Option<&str>) -> Value {
    let all = skills(data, me);
    let read =
        |k: &Value| std::fs::read_to_string(k["path"].as_str().unwrap_or("")).unwrap_or_default();
    let Some(name) = name else {
        let list: Vec<Value> = (all.iter())
            .map(|k| json!({"name": k["name"], "description": described(&read(k)), "path": k["path"]}))
            .collect();
        let text: String = match list.is_empty() {
            true => "No skills.\n".into(),
            false => (list.iter())
                .map(|k| {
                    format!(
                        "{}  {}\n",
                        k["name"].as_str().unwrap_or(""),
                        k["description"].as_str().unwrap_or("")
                    )
                })
                .collect(),
        };
        return json!({"ok": true, "skills": list, "text": text + "`brigadier skill <name>` prints one."});
    };
    let Some(k) = all.iter().find(|k| k["name"] == name) else {
        return json!({"ok": false, "error": format!("No skill {name:?}. `brigadier skill` lists them.")});
    };
    let path = k["path"].as_str().unwrap_or("");
    let folder = Path::new(path)
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let mut text = read(k);
    // The reply's cap cuts from the start; a skill is read from its start.
    if text.len() > 15 << 10 {
        let mut at = 15 << 10;
        while !text.is_char_boundary(at) {
            at -= 1;
        }
        text.truncate(at);
        text += &format!("\n[cut; the rest is in {path}]");
    }
    json!({"ok": true, "name": name, "path": path, "folder": folder,
        "text": format!("{text}\n\n[Its folder: {folder}]")})
}

/// `search`: the archive entries holding every word, each with its session's title [D103].
fn search(
    data: &Path,
    words: &str,
    value: &dyn Fn(&str) -> Option<String>,
    rows: &[Value],
) -> Value {
    let (within, from, file) = (value("--in"), value("--from"), value("--file"));
    if words.trim().is_empty() && file.is_none() {
        return json!({"ok": false, "error": "`brigadier search` needs words, in quotes, or --file."});
    }
    let senders = ["user", "agent", "worker", "peer", "tool", "error"];
    if from.as_deref().is_some_and(|f| !senders.contains(&f)) {
        return json!({"ok": false, "error": format!("--from takes one of {}.", senders.join(", "))});
    }
    let hits = match crate::index::find(
        data,
        words,
        within.as_deref(),
        from.as_deref(),
        file.as_deref(),
    ) {
        Ok(h) => h,
        Err(e) => return json!({"ok": false, "error": e.to_string()}),
    };
    let title = |id: &Value| {
        let row = rows.iter().find(|r| r["id"] == *id);
        row.and_then(|r| r["title"].as_str())
            .filter(|t| !t.is_empty())
            .unwrap_or("Untitled")
            .to_string()
    };
    let list: Vec<Value> = (hits.iter())
        .map(|h| {
            let at = format!("{}#{}", h["id"].as_str().unwrap_or(""), h["at"].as_str().unwrap_or(""));
            json!({"ref": at, "session": h["id"], "title": title(&h["id"]), "from": h["from"], "ts": h["ts"],
                "line": h["snippet"], "files": h["files"]})
        })
        .collect();
    let text: String = match list.is_empty() {
        true => "Nothing holds every word in one message. Try fewer words.\n".into(),
        false => (list.iter())
            .map(|h| {
                let s = |k: &str| h[k].as_str().unwrap_or("").to_string();
                let line = match (s("line"), s("files")) {
                    (l, f) if l.is_empty() => f,
                    (l, _) => l,
                };
                let age = crate::agent::ago(h["ts"].as_u64().unwrap_or(0));
                format!(
                    "{} · {} · {age} · {}\n  {line}\n",
                    s("ref"),
                    s("from"),
                    s("title")
                )
            })
            .collect(),
    };
    json!({"ok": true, "found": list, "text": text})
}

/// An archive entry's sender as `read` names it.
fn sender(e: &core::archive::Entry) -> String {
    match e.from {
        "worker" => format!("result from {}", e.who),
        "peer" => format!("message from {}", e.who),
        "tool" if e.who.is_empty() => "files changed".into(),
        "tool" => format!("tool {}", e.who),
        f => f.into(),
    }
}

/// The session's archive, oldest first: a fork's inherited copy, then its own active branch [D103].
/// Without `steps`, only the messages: the user's, other senders' and its agent's texts.
pub(crate) fn archive(data: &Path, id: &str, steps: bool) -> Vec<core::archive::Entry> {
    let mut all = core::archive::read(&core::session_dir(data, id)).unwrap_or_default();
    all.retain(|e| steps || matches!(e.from, "user" | "agent" | "worker" | "peer"));
    all
}

/// `row` is the session's own index row: its agent and project head what's read.
pub(crate) fn read(
    data: &Path,
    id: &str,
    row: &Value,
    at: Option<&str>,
    last: u64,
    user: bool,
) -> Value {
    // A step's reference from a hand-off opens its whole output, from the log [D485].
    let dir = core::session_dir(data, id);
    if let Some((at, (tool, out))) = at.and_then(|at| Some((at, core::archive::output(&dir, at)?)))
    {
        // The text is cut once, from its start, as any reply's; the JSON's copy here.
        let text = format!("[{id}#{at} output of {tool}]\n{}\n", out.trim_end());
        let out = crate::agent::cap(out.trim_end());
        let list = vec![
            json!({"ref": format!("{id}#{at}"), "from": format!("output of {tool}"), "text": out, "files": []}),
        ];
        return opened(data, id, row, text, list, 0);
    }
    let mut all = archive(data, id, at.is_some());
    if user {
        all.retain(|e| e.from == "user");
    }
    // Around a reference: `last` entries on each side of it.
    let (from, to) = match at {
        Some(at) => {
            let Some(i) = all.iter().position(|e| e.at == at) else {
                return crate::agent::refuse(&format!(
                    "{id} has no #{at}. `brigadier search` gives references."
                ));
            };
            let j = all.iter().rposition(|e| e.at == at).unwrap_or(i);
            (
                i.saturating_sub(last as usize),
                (j + 1 + last as usize).min(all.len()),
            )
        }
        None => (all.len().saturating_sub(last as usize), all.len()),
    };
    let shown = &all[from..to];
    let mut text: String = (shown.iter())
        .map(|e| {
            let files = match e.files.is_empty() {
                true => String::new(),
                false => format!("\n(files: {})", e.files.join(", ")),
            };
            format!(
                "[{id}#{} {}]\n{}{files}\n\n",
                e.at,
                sender(e),
                e.text.trim_end()
            )
        })
        .collect();
    if from > 0 && at.is_none() {
        let flag = if user { " --user" } else { "" };
        text = format!(
            "[{from} earlier; brigadier read {id} --last {}{flag}]\n\n{text}",
            last + from as u64
        );
    }
    let list: Vec<Value> = (shown.iter())
        .map(|e| json!({"ref": format!("{id}#{}", e.at), "from": sender(e), "text": e.text, "files": e.files}))
        .collect();
    opened(data, id, row, text, list, from)
}

/// What `read` opened, under a line naming the session's agent and project.
fn opened(
    data: &Path,
    id: &str,
    row: &Value,
    text: String,
    list: Vec<Value>,
    from: usize,
) -> Value {
    let agent = row["backend"].as_str().unwrap_or("");
    let project = (row["project"].as_str())
        .and_then(|p| {
            core::projects::list(data)
                .ok()?
                .into_iter()
                .find(|x| x.id == p)
        })
        .map(|p| p.name);
    let place = project
        .as_ref()
        .map_or("no project".into(), |p| format!("project {p}"));
    let text = format!("[{id}: {agent}, {place}]\n\n{text}");
    json!({"ok": true, "agent": agent, "project": project, "messages": list, "earlier": from, "text": text})
}
