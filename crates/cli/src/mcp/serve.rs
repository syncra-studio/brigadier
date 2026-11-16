//! `brigadier mcp-server`: Brigadier's own MCP server on stdio, which every agent is given
//! [D529, D530]. Its one tool, `show_draft`, shows the user a message for someone as a card: the
//! format lives in its schema, not the standing text. The call's input is the card; the server
//! only checks it and answers.

use serde_json::{Value, json};
use std::io::{BufRead, Write};

const DESCRIPTION: &str = "Show the user a message to a person in chat, a DM or an email that you drafted or posted, however short, even when they didn't ask to see it. Brigadier draws it as a card with Copy, in its place in your reply. Whether to send a draft is a question for your question tool, after this.";

/// The tool as `tools/list` gives it.
fn tool() -> Value {
    let words = |d: &str| json!({"type": "string", "description": d});
    json!({"name": "show_draft", "description": DESCRIPTION, "inputSchema": {"type": "object", "additionalProperties": false,
        "required": ["to", "state", "text"], "properties": {
            "to": words("Where it goes and to whom, like \"Slack DM · Lucia\"."),
            "state": {"type": "string", "enum": ["draft", "posted"], "description": "\"posted\" once it was sent."},
            "quote": {"type": "object", "additionalProperties": false, "required": ["from", "text"], "description": "What it answers, when it answers someone.",
                "properties": {"from": words("Who wrote it."), "text": words("Their exact words.")}},
            "text": words("The message exactly as it goes, plain text.")}}})
}

/// Why a call's input isn't a card, if it isn't.
fn refused(input: &Value) -> Option<&'static str> {
    let text = |v: &Value| v.as_str().is_some_and(|s| !s.trim().is_empty());
    if !text(&input["to"]) || !text(&input["text"]) {
        return Some("`to` and `text` must be non-empty strings.");
    }
    if !matches!(input["state"].as_str(), Some("draft" | "posted")) {
        return Some("`state` must be \"draft\" or \"posted\".");
    }
    let quote = &input["quote"];
    (!quote.is_null() && !(text(&quote["from"]) && text(&quote["text"])))
        .then_some("`quote` needs `from` and `text`.")
}

/// Answers JSON-RPC on stdin, one message a line, until stdin closes.
pub fn run() {
    let mut out = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // A notification gets no answer.
        let Some(id) = msg.get("id").cloned() else {
            continue;
        };
        let params = &msg["params"];
        let result = match msg["method"].as_str().unwrap_or("") {
            "initialize" => {
                json!({"protocolVersion": params["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": {"tools": {}}, "serverInfo": {"name": "brigadier", "version": env!("CARGO_PKG_VERSION")}})
            }
            "ping" => json!({}),
            "tools/list" => json!({"tools": [tool()]}),
            "tools/call" if params["name"] == "show_draft" => {
                let why = refused(&params["arguments"]);
                json!({"content": [{"type": "text", "text": why.unwrap_or("Shown to the user.")}], "isError": why.is_some()})
            }
            method => {
                let error = json!({"code": -32601, "message": format!("no method {method}")});
                let _ = writeln!(
                    out,
                    "{}",
                    json!({"jsonrpc": "2.0", "id": id, "error": error})
                );
                let _ = out.flush();
                continue;
            }
        };
        let _ = writeln!(
            out,
            "{}",
            json!({"jsonrpc": "2.0", "id": id, "result": result})
        );
        let _ = out.flush();
    }
}
