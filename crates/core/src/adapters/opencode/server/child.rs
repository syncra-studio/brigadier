//! A subagent's own session, as OpenCode's server reports it to the helper.

use super::State;
use serde_json::{Value, json};

/// A background subagent's report waking its parent: the line that ends the call that ran it.
pub(super) fn report(st: &State, v: &Value) -> Option<Value> {
    let p = &v["data"]["item"]["payload"];
    let child = p["metadata"]["childID"].as_str().unwrap_or("");
    let key = st.children.get(child)?;
    let ok = p["metadata"]["state"] == "completed";
    let t = st.tools.get(key).cloned().unwrap_or_default();
    Some(
        json!({"type": if ok { "session.tool.success" } else { "session.tool.failed" },
        "created": v["created"], "data": {"sessionID": st.session, "id": key,
        "name": t["name"], "input": t["input"], "metadata": {"sessionID": child},
        "content": [{"type": "text", "text": p["text"]}],
        "error": {"message": p["text"]}}}),
    )
}

/// A tool event of a subagent's session (`child`), named by the call that runs it, for its side
/// panel [D115]; false when there's nothing to pass on yet.
pub(super) fn step(st: &mut State, child: &str, k: &str, v: &mut Value) -> bool {
    let d = &v["data"];
    let call = st.children[child].clone();
    let msg = d["assistantMessageID"].as_str().unwrap_or("");
    let key = format!("{child}/{msg}/{}", d["id"].as_str().unwrap_or(""));
    match k {
        "session.tool.input.started" => {
            st.tools.insert(key, json!({"name": d["name"]}));
            return false;
        }
        "session.tool.called" => {
            st.tools.entry(key.clone()).or_default()["input"] = d["input"].clone();
        }
        "session.tool.success" | "session.tool.failed" => {}
        _ => return false,
    }
    let t = st.tools.get(&key).cloned().unwrap_or_default();
    v["data"]["id"] = key.into();
    v["data"]["name"] = t["name"].clone();
    v["data"]["input"] = t["input"].clone();
    v["data"]["parent"] = call.into();
    true
}
