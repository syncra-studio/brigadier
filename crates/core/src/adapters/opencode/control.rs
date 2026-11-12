//! What OpenCode's server is told: the model, the level as its permission rules, messages and
//! answers.

use super::super::s;
use crate::Spec;
use serde_json::{Value, json};

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

/// A level as its permission rules, the last match winning [D175]. Ask (proposed): it reads,
/// searches and asks questions freely, and asks before anything else and before reading secrets.
pub fn rules(spec: &Spec) -> Value {
    let rule = |action: &str, resource: &str, effect: &str| json!({"action": action, "resource": resource, "effect": effect});
    if spec.level.as_deref() == Some("full") {
        return json!([rule("*", "*", "allow")]);
    }
    let free = ["read", "glob", "grep", "question"].map(|a| rule(a, "*", "allow"));
    let secrets = [
        rule("read", "*.env", "ask"),
        rule("read", "*.env.*", "ask"),
        rule("read", "*.env.example", "allow"),
    ];
    let mut all = vec![rule("*", "*", "ask")];
    all.extend(free.into_iter().chain(secrets));
    all.into()
}

/// What a deny tells the agent, with the user's reason when they gave one [D192].
pub fn denied(reason: &str) -> String {
    match reason.trim() {
        "" => "The user denied this.".into(),
        why => format!("The user denied this: {why}"),
    }
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
