//! A subagent's own thread, as Codex's app-server reports it to the helper.

use super::{Pending, State, ask, input};
use serde_json::{Value, json};
use std::sync::mpsc::channel;

/// A subagent's own thread: only its latest words are kept, its answer once it ends.
pub(super) fn child(st: &mut State, method: &str, p: &Value) {
    if method == "item/completed" && p["item"]["type"] == "agentMessage" {
        let id = p["threadId"].as_str().unwrap_or("");
        st.said
            .insert(id.into(), p["item"]["text"].as_str().unwrap_or("").into());
    }
}

/// A subagent started or ended, on its parent's thread; an end carries its answer. Codex leaves an
/// idle parent asleep when its subagents end, so the last one's end wakes it, as other CLIs do [D106].
pub(super) fn activity(st: &mut State, item: &mut Value) {
    let id = item["agentThreadId"].as_str().unwrap_or("").to_string();
    match item["kind"].as_str() {
        Some("started") => drop(st.running.insert(id)),
        Some("completed" | "interrupted") => {
            item["output"] = st.said.remove(&id).unwrap_or_default().into();
            st.running.remove(&id);
            if st.running.is_empty() && st.turn.is_empty() && !st.stopped {
                let text = "Your subagents have finished. Carry on with their results.";
                let params = json!({"threadId": st.thread, "input": input(&text.into())});
                ask(st, "turn/start", params, Pending::Wait(channel().0));
            }
        }
        _ => {}
    }
}
