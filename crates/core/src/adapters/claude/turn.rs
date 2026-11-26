//! A turn as its stream reads: which inputs it took, and how it ended.

use super::super::{Event, classify, s};
use serde_json::Value;

/// The inputs this frame says the turn took, by the `uuid` each was written with: the Agent SDK's
/// `user_message_uuid(s)` on the turn's first reply, its `thinking_tokens` and its result [D66].
pub fn echoed(v: &Value) -> Vec<Event> {
    let documented = match s(v, &["type"]) {
        "stream_event" | "assistant" | "result" => true,
        "system" => v["subtype"] == "thinking_tokens",
        _ => false,
    };
    let one = v["user_message_uuid"].as_str();
    let many = (v["user_message_uuids"].as_array().into_iter().flatten()).filter_map(Value::as_str);
    let mut ids: Vec<&str> = one.into_iter().chain(many).collect();
    ids.dedup();
    (ids.into_iter().filter(|_| documented))
        .map(|id| Event::Reply {
            id: id.into(),
            error: None,
            level: None,
        })
        .collect()
}

/// The inputs a Stop's interrupt cancelled before Claude read them, by `uuid`: its receipt's
/// `cancelled` (the Agent SDK's `SDKControlInterruptResponse`). Each settles as never taken [D66].
pub fn cancelled(v: &Value) -> Vec<Event> {
    let r = &v["response"];
    let ids = (r["subtype"] == "success").then(|| r["response"]["cancelled"].as_array());
    (ids.flatten()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str))
    .map(|id| Event::Reply {
        id: id.into(),
        error: Some("Stopped before the agent read it.".into()),
        level: None,
    })
    .collect()
}

/// A turn's result: its usage with its cost so far, as the CLI reports it [D221], and how it ended.
pub fn result(v: &Value) -> Vec<Event> {
    let mut usage = v["usage"].clone();
    if let Some(u) = usage.as_object_mut() {
        u.insert("cost_usd".into(), v["total_cost_usd"].clone());
    }
    let mut events = vec![Event::Usage(usage)];
    // A refusal is named by its stop reason, whatever it ends as.
    let refused = v["stop_reason"] == "refusal";
    let failed = refused || v["is_error"] == true;
    if failed {
        let said = format!("{} {}", s(v, &["result"]), v["errors"]);
        // Its errors as lines, without the CLI's own diagnostics ("[lede_diagnostic] …",
        // "[ede_diagnostic] …" for a turn it was told to stop), which no user can read [D85].
        let diagnostic = |e: &str| {
            (e.split_once(']'))
                .is_some_and(|(tag, _)| tag.starts_with('[') && tag.ends_with("_diagnostic"))
        };
        let text = match s(v, &["result"]) {
            "" => (v["errors"].as_array().into_iter().flatten())
                .filter_map(Value::as_str)
                .filter(|e| !diagnostic(e))
                .collect::<Vec<_>>()
                .join("\n"),
            text => text.into(),
        };
        events.push(if v["api_error_status"] == 529 {
            Event::Failed("capacity", text)
        } else if v["api_error_status"] == 429 {
            Event::Limited(text, None)
        } else if refused {
            Event::Failed("blocked", text)
        } else {
            classify(&said).unwrap_or(Event::Failed("", text))
        });
    }
    events.push(Event::TurnEnd(!failed));
    events
}
