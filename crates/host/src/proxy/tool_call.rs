//! Which refused requests the thread hears of [D761]: a CLI connects to every server at start
//! (initialize, tools/list), and that alone is no news; a tool the agent called is.

use serde_json::Value;

/// Whether a POST's JSON-RPC (one message or a batch) calls a tool.
pub(super) fn calls_tool(body: &[u8]) -> bool {
    let msg: Value = serde_json::from_slice(body).unwrap_or_default();
    let call = |m: &Value| m["method"] == "tools/call";
    msg.as_array()
        .map_or(call(&msg), |all| all.iter().any(call))
}
