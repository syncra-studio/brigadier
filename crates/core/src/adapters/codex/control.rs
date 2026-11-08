//! What Codex's app-server is told: the session's level as its own policy, turns and answers.

use crate::Spec;
use serde_json::{Value, json};

/// A level as Codex's approval policy, reviewer and sandbox [D175, D187]. Auto is the same policy
/// and sandbox as Ask with its auto reviewer, set per thread and turn, never in its config [D215].
fn level(spec: &Spec) -> (&'static str, &'static str, &'static str, &'static str) {
    match spec.level.as_deref() {
        Some("full") => ("never", "user", "danger-full-access", "dangerFullAccess"),
        Some("auto") => (
            "on-request",
            "auto_review",
            "workspace-write",
            "workspaceWrite",
        ),
        _ => ("on-request", "user", "workspace-write", "workspaceWrite"),
    }
}

/// `thread/start` or `thread/resume`'s settings.
pub fn open(spec: &Spec, resume: Option<&str>) -> Value {
    let (policy, reviewer, sandbox, _) = level(spec);
    let mut open = json!({"cwd": spec.cwd, "approvalPolicy": policy, "approvalsReviewer": reviewer, "sandbox": sandbox});
    if let Some(model) = &spec.model {
        open["model"] = model.as_str().into();
    }
    if let Some(id) = resume {
        open["threadId"] = id.into();
    }
    open
}

/// One line for the helper to send as `turn/start`. Level, model and effort ride on every turn, so
/// Codex checks them with the prompt and refuses it whole if it can't apply them [D222].
pub fn turn(spec: &Spec, text: &str) -> Value {
    let (policy, reviewer, _, sandbox) = level(spec);
    let mut turn = json!({"input": [{"type": "text", "text": text}], "approvalPolicy": policy,
        "approvalsReviewer": reviewer, "sandboxPolicy": {"type": sandbox}, "clientUserMessageId": spec.cid});
    if let Some(model) = &spec.model {
        turn["model"] = model.as_str().into();
    }
    if let Some(effort) = &spec.effort {
        turn["effort"] = effort.as_str().into();
    }
    json!({"id": spec.cid, "turn": turn})
}

/// An answer as the line that carries Codex's own result. A deny's reason goes into the turn just
/// before the deny, so the agent reads it with the refusal [D192].
pub fn answer(spec: &Spec, msg: &Value) -> Result<Value, String> {
    let r = &msg["request"];
    let cli = &r["cli"];
    let decision = msg["decision"].as_str().unwrap_or("");
    let allowed = decision != "deny";
    let result = if r["items"].is_array() {
        answers(cli, msg)
    } else {
        match cli["method"].as_str().unwrap_or("") {
            "item/permissions/requestApproval" => match allowed {
                true => json!({"permissions": cli["permissions"], "scope": "turn"}),
                false => json!({"permissions": {}, "scope": "turn"}),
            },
            "mcpServer/elicitation/request" => match allowed {
                true => json!({"action": "accept", "content": {}}),
                false => json!({"action": "decline"}),
            },
            _ => json!({"decision": match decision {
                "allowSession" => "acceptForSession",
                "deny" => "decline",
                _ => "accept",
            }}),
        }
    };
    let mut line = json!({"id": spec.cid, "answer": {"rid": cli["rid"], "result": result}});
    if decision == "allowSession" {
        line["grant"] = r.clone();
    }
    let why = msg["reason"].as_str().map_or("", str::trim);
    if !allowed && !why.is_empty() {
        line["before"] = format!("The user denied this: {why}").into();
        line["thread"] = cli["thread"].clone();
        line["turn"] = cli["turn"].clone();
    }
    Ok(line)
}

/// A round's answers by question id; a skipped question stays out.
fn answers(cli: &Value, msg: &Value) -> Value {
    let ids = cli["ids"].as_array().cloned().unwrap_or_default();
    let given = msg["answers"].as_array().cloned().unwrap_or_default();
    let mut out = serde_json::Map::new();
    for (id, a) in ids.iter().zip(&given) {
        if let (Some(id), Some(a)) = (id.as_str(), a.as_str()) {
            out.insert(id.into(), json!({"answers": [a]}));
        }
    }
    json!({"answers": out})
}
