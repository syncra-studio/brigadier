//! What OpenCode's server is told: the model, the level as its permission rules, messages and
//! answers.

use super::super::{ModelInfo, s};
use crate::Spec;
use serde_json::{Value, json};

/// Its inline config: the instructions file and no compaction of its own, as Brigadier's rebirth
/// stands in for it [D88]; for a worker also no MCP servers, skills or plugins, its `.claude`
/// folders unread [D89].
pub fn config(spec: &Spec, style: &std::path::Path, env: &mut Vec<(String, String)>) -> Value {
    let mut config =
        json!({"instructions": [style.display().to_string()], "compaction": {"auto": false}});
    // Its to-do tool, an experimental flag (packages/schema/src/config/flag.ts) [D104, D116].
    config["experimental"] = json!({"todo": crate::rebirth::todo()});
    // Where a rule names OpenCode, its subagent-mode agents start on the session's model and
    // capped effort; its task tool can still name others [D376].
    if spec.ruled.touched {
        let mut agent = json!({"model": model(spec)});
        if let Some(e) = &spec.effort {
            agent["variant"] = e.as_str().into();
        }
        config["agent"] = json!({"general": agent, "explore": agent});
    }
    if spec.naked {
        let deny = |action| json!({"action": action, "resource": "*", "effect": "deny"});
        config["policies"] = json!(["mcp.use", "skill.use", "plugin.use"].map(deny));
        env.push(("OPENCODE_DISABLE_CLAUDE_CODE".into(), "1".into()));
    } else if let Some(kit) = crate::library::kit(spec, &[]) {
        library(&mut config, &kit, spec);
    }
    // Brigadier's own `show_draft`, never asked about: it only shows the user a message [D529, D530].
    if !spec.naked {
        let me = (std::env::current_exe().unwrap_or_default()).with_file_name("brigadier");
        let command = json!([me.display().to_string(), "mcp-server"]);
        config["mcp"]["servers"]["brigadier"] = json!({"type": "local", "command": command});
    }
    config
}

/// The library [D2043]: its skills' folder, which outranks the user's own of a name
/// (opencode.ai/docs/skills#precedence), its local servers by their Brigadier names, and the
/// user's own copy of each server off for this session (opencode.ai/docs/mcp-servers) [D407].
fn library(config: &mut Value, kit: &crate::library::Kit, spec: &Spec) {
    config["skills"] = json!([kit.skills]);
    let mut mcp = serde_json::Map::new();
    let own = super::commands::mcp_servers(std::path::Path::new(&spec.cwd));
    let (given, off) = crate::library::split(&kit.servers, &own);
    for s in &given {
        let name = crate::library::named(s["name"].as_str().unwrap_or(""));
        // A remote one through the proxy, its own OAuth off; one only each agent signs in to keeps it.
        if s["to"].is_string() {
            let mut remote = json!({"type": "remote", "url": s["to"], "headers": s["headers"]});
            if s["sign_in"] != "cli" {
                remote["oauth"] = false.into();
            }
            mcp.insert(name, remote);
            continue;
        }
        let args = s["args"].as_array().cloned().unwrap_or_default();
        let command: Vec<Value> = std::iter::once(s["command"].clone()).chain(args).collect();
        let env = s["env"].as_object().cloned().unwrap_or_default();
        mcp.insert(
            name,
            json!({"type": "local", "command": command, "environment": env}),
        );
    }
    for name in off {
        // Off whether its entry is replaced or merged: a stub that never connects.
        let off = json!({"type": "local", "command": ["true"], "disabled": true});
        mcp.insert(name, off);
    }
    config["mcp"] = json!({ "servers": mcp });
}

/// A model from its server's list, as the old app read it: its name, its variants as its efforts,
/// and images where its input names them or says nothing [D2098].
pub fn model_info(m: &Value, local: &impl Fn(&str) -> bool) -> ModelInfo {
    let id = format!("{}/{}", s(m, &["providerID"]), s(m, &["id"]));
    let input = m["capabilities"]["input"].as_array();
    let variants = m["variants"].as_array().into_iter().flatten();
    ModelInfo {
        name: m["name"].as_str().unwrap_or(&id).into(),
        efforts: (variants.filter_map(|v| v["id"].as_str().map(String::from))).collect(),
        images: Some(input.is_none_or(|i| i.is_empty() || i.iter().any(|x| x == "image"))),
        window: m["limit"]["context"].as_u64(),
        ..ModelInfo::plain(&id, local(&id))
    }
}

/// The model a session runs; a free one OpenCode serves when none is picked.
pub fn model(spec: &Spec) -> String {
    (spec.model.clone()).unwrap_or_else(|| "opencode/deepseek-v4.1-flash-free".into())
}

/// The model as its server names it: `provider/model`, the effort as its variant.
pub fn model_ref(spec: &Spec) -> Value {
    let model = model(spec);
    let (provider, id) = model.split_once('/').unwrap_or(("opencode", &model));
    let mut r = json!({"id": id, "providerID": provider});
    if let Some(e) = &spec.effort {
        r["variant"] = e.as_str().into();
    }
    r
}

/// Commands Auto still asks before: destructive ones and network installs [D130]. A plain curl
/// runs; one piped into a shell asks, as OpenCode checks each part of a pipe [D152].
const RISKY: &str = concat!(
    "rm *|rmdir *|sudo *|dd *|mkfs*|chmod -R *|chown *|kill *|pkill *|killall *|git push*|",
    "git reset --hard*|git clean *|git checkout -- *|sh|bash|zsh|sh -s *|bash -s *|npx *|npm install*|",
    "npm i *|npm add *|pnpm add *|pnpm install *|yarn add *|bun add *|pip install *|",
    "pip3 install *|uv add *|cargo install *|brew install *|gem install *",
);

/// The Auto rules that ask for a command naming an absolute, home or `..` path [D130].
pub(super) const PATHS: [&str; 3] = ["* /*", "* ~*", "*..*"];

/// A level as its permission rules, the last match winning [D175]. Ask (proposed): it reads,
/// searches, asks questions and keeps its to-do list freely [D116], and asks before anything else
/// and before reading secrets. Auto, on OpenCode's own per-tool rules: it also edits, runs commands,
/// fetches pages and starts its subagents in the project unasked; outside the project, destructive
/// commands and network installs still ask [D130].
pub fn rules(spec: &Spec) -> Value {
    let rule = |action: &str, resource: &str, effect: &str| json!({"action": action, "resource": resource, "effect": effect});
    // A folder chat reads the repos where they are and never edits them there, at every level,
    // after the level's own rules so they win [D494].
    let folder = crate::folder::of(spec).map(|p| format!("{}/*", p.folder));
    let folder = (folder.iter()).flat_map(|f| {
        [
            ("external_directory", "allow"),
            ("read", "allow"),
            ("edit", "deny"),
        ]
        .map(|(a, e)| rule(a, f, e))
    });
    if spec.level.as_deref() == Some("full") {
        return [rule("*", "*", "allow")]
            .into_iter()
            .chain(folder)
            .collect();
    }
    // Brigadier's `show_draft` asks nothing: it only shows the user a message [D529].
    let free = [
        "read",
        "glob",
        "grep",
        "question",
        "todowrite",
        "brigadier_show_draft",
    ];
    let free = free.map(|a| rule(a, "*", "allow"));
    let secrets = [
        rule("read", "*.env", "ask"),
        rule("read", "*.env.*", "ask"),
        rule("read", "*.env.example", "allow"),
    ];
    let mut all = vec![rule("*", "*", "ask")];
    all.extend(free);
    if spec.level.as_deref() == Some("auto") {
        all.extend(["edit", "shell", "webfetch", "subagent"].map(|a| rule(a, "*", "allow")));
        // OpenCode checks only a command's folder (cd), not the paths it names: a command naming
        // one asks, and the helper answers it when each resolves inside the project (`inside`).
        all.extend(PATHS.map(|p| rule("shell", p, "ask")));
        all.extend(RISKY.split('|').map(|c| rule("shell", c, "ask")));
    }
    all.extend(secrets);
    all.extend(folder);
    all.into()
}

/// A question's answers by field key, or the user's own message as the first one. A skipped
/// question stays out; a multiselect takes the labels it names, else the text as one answer.
pub fn answers(r: &Value, msg: &Value) -> Value {
    if let Some(reply) = msg["reply"].as_str() {
        return json!({"q0": reply});
    }
    let fields = r["cli"]["fields"].as_array().cloned().unwrap_or_default();
    let given = msg["answers"].as_array().cloned().unwrap_or_default();
    let mut out = serde_json::Map::new();
    for (f, a) in fields.iter().zip(&given) {
        let Some(a) = a.as_str() else { continue };
        let labels: Vec<&str> = (f["options"].as_array().into_iter().flatten())
            .filter_map(|o| o["label"].as_str())
            .collect();
        let picked: Vec<&str> = a.split(", ").collect();
        let value = match f["type"] == "multiselect" {
            true if picked.iter().all(|p| labels.contains(p)) => json!(picked),
            true => json!([a]),
            false => a.into(),
        };
        out.insert(s(f, &["key"]).into(), value);
    }
    out.into()
}

/// A message as the helper's line: one whose chip names its own command goes as that command, the
/// rest of the message its text; any other as a prompt [D164].
pub fn message(spec: &Spec, text: &str) -> Value {
    let picked = (spec.commands.iter()).find(|c| c["kind"] == "command" && c["instant"] != true);
    let Some(name) = picked.and_then(|c| c["name"].as_str()) else {
        return json!({"prompt": prompt(spec, text), "id": spec.cid});
    };
    let mut command = prompt(spec, text.replacen(&format!("/{name}"), "", 1).trim());
    command["name"] = name.into();
    json!({"command": command, "id": spec.cid})
}

/// A message as OpenCode's prompt: its text, each image as a v2 attachment by its `file:` uri
/// [D2008], each skill its chips name by its id [D2009].
pub fn prompt(spec: &Spec, text: &str) -> Value {
    let files: Vec<Value> = (spec.images.iter())
        .map(|p| json!({"uri": format!("file://{}", p.display()), "name": p.file_name().map(|n| n.to_string_lossy())}))
        .collect();
    let skills: Vec<Value> = (spec.commands.iter())
        .filter(|c| c["kind"] == "skill")
        .map(|c| json!({"id": c["name"]}))
        .collect();
    let mut prompt = json!({"text": text});
    if !files.is_empty() {
        prompt["files"] = files.into();
    }
    if !skills.is_empty() {
        prompt["skills"] = skills.into();
    }
    prompt
}

/// A job the user stopped from the card, said plainly and steered into the wake its own exit
/// notice starts, so the agent doesn't start it again [D117].
pub fn stopped(spec: &Spec, msg: &Value) -> Value {
    let mut p = prompt(spec, &super::super::stopped(msg));
    p["delivery"] = "steer".into();
    p
}

/// Its `--version` line ("1.19.5", "opencode v2.2.7") names a version before 2.
pub(super) fn before_2(version: &str) -> bool {
    let number = version.trim_start_matches(|c: char| !c.is_ascii_digit());
    matches!(number.split('.').next(), Some("0" | "1"))
}
