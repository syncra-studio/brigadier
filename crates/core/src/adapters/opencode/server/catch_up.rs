//! The helper's catch-up after its event stream reconnects.

use super::super::http::Server;
use super::{Shared, event, say};
use serde_json::{Value, json};

/// After a reconnect: what the session recorded meanwhile (from its messages, its own record),
/// printed once each, the turn's real outcome if it ended, then the requests still waiting.
pub(super) fn catch_up(server: &Server, state: &Shared) {
    let session = state.lock().unwrap().session.clone();
    if session.is_empty() {
        return;
    }
    let get = |rest: &str| -> Vec<Value> {
        let path = format!("/api/session/{session}{rest}");
        let v: Value = (server.request("GET", &path, &Value::Null).ok())
            .and_then(|(_, body)| serde_json::from_str(&body).ok())
            .unwrap_or_default();
        v["data"].as_array().cloned().unwrap_or_default()
    };
    let newest = state.lock().unwrap().newest.clone();
    let mut messages = get("/message?limit=50");
    messages.reverse();
    for m in messages
        .iter()
        .filter(|m| m["id"].as_str().unwrap_or("") >= newest.as_str())
    {
        let msg = m["id"].as_str().unwrap_or("");
        let base = json!({"sessionID": session, "assistantMessageID": msg});
        match m["type"].as_str() {
            // A message sent while away began a turn [D5, D251].
            Some("user") => state.lock().unwrap().busy = true,
            Some("assistant") => {
                for (i, part) in m["content"].as_array().into_iter().flatten().enumerate() {
                    let mut d = base.clone();
                    let kind = match part["type"].as_str() {
                        Some("text") => "session.text.ended",
                        Some("reasoning") => "session.reasoning.ended",
                        Some("tool") => {
                            let s = &part["state"];
                            d["id"] = part["id"].clone();
                            let started = json!({"sessionID": session, "assistantMessageID": msg, "id": part["id"], "name": part["name"]});
                            event(
                                server,
                                state,
                                json!({"type": "session.tool.input.started", "data": started}),
                            );
                            d["input"] = s["input"].clone();
                            event(
                                server,
                                state,
                                json!({"type": "session.tool.called", "data": d.clone()}),
                            );
                            let end = match s["status"].as_str() {
                                Some("completed") => "session.tool.success",
                                Some("error") => "session.tool.failed",
                                _ => continue,
                            };
                            d["content"] = s["content"].clone();
                            d["metadata"] = s["metadata"].clone();
                            d["error"] = s["error"].clone();
                            event(server, state, json!({"type": end, "data": d}));
                            continue;
                        }
                        _ => continue,
                    };
                    d["ordinal"] = i.into();
                    d["text"] = part["text"].clone();
                    event(server, state, json!({"type": kind, "data": d}));
                }
            }
            // The turn ended while away: its outcome as the session recorded it, never guessed.
            Some("idle") if state.lock().unwrap().busy => {
                let outcome = m["outcome"].as_str().unwrap_or("failed");
                event(
                    server,
                    state,
                    json!({"type": format!("session.execution.{outcome}"), "data": base}),
                );
            }
            _ => {}
        }
    }
    let permissions = get("/permission");
    let forms: Vec<Value> = get("/form")
        .into_iter()
        .filter(|f| f["metadata"]["kind"] == "question")
        .collect();
    let gone: Vec<String> = {
        let st = state.lock().unwrap();
        let listed = |id: &String| {
            permissions
                .iter()
                .chain(&forms)
                .any(|r| r["id"] == id.as_str())
        };
        st.asked
            .keys()
            .chain(&st.forms)
            .filter(|id| !listed(id))
            .cloned()
            .collect()
    };
    for id in gone {
        let mut st = state.lock().unwrap();
        st.asked.remove(&id);
        st.forms.remove(&id);
        drop(st);
        say(json!({"type": "brigadier.gone", "data": {"id": id}}));
    }
    for p in permissions {
        if !state
            .lock()
            .unwrap()
            .asked
            .contains_key(p["id"].as_str().unwrap_or(""))
        {
            event(
                server,
                state,
                json!({"type": "permission.asked", "data": p}),
            );
        }
    }
    for f in forms {
        if !state
            .lock()
            .unwrap()
            .forms
            .contains(f["id"].as_str().unwrap_or(""))
        {
            event(
                server,
                state,
                json!({"type": "form.created", "data": {"form": f}}),
            );
        }
    }
}
