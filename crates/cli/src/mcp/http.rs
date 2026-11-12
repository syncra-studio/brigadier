//! MCP's Streamable HTTP transport, one POST at a time.

use serde_json::Value;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

/// One Streamable HTTP POST through the system's curl (its TLS; no client of our own): the answers
/// in its JSON or event-stream body, its session id kept.
pub(super) fn post(
    url: &str,
    headers: Option<&Path>,
    session: &mut Option<String>,
    msg: &Value,
    wait: Duration,
) -> Result<Vec<Value>, String> {
    let mut c = Command::new("/usr/bin/curl");
    c.args([
        "-sS",
        "-X",
        "POST",
        "-D",
        "-",
        "--max-time",
        &wait.as_secs().to_string(),
    ])
    .args([
        "-H",
        "Content-Type: application/json",
        "-H",
        "Accept: application/json, text/event-stream",
    ])
    .args(["--data-binary", "@-"]);
    if let Some(h) = headers {
        c.args(["-H".into(), format!("@{}", h.display())]);
    }
    if let Some(s) = session.as_ref() {
        c.args(["-H".into(), format!("Mcp-Session-Id: {s}")]);
    }
    let mut child = (c
        .arg(url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn())
    .map_err(|e| e.to_string())?;
    let _ = child
        .stdin
        .take()
        .unwrap()
        .write_all(msg.to_string().as_bytes());
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    // Past any interim `100 Continue` head.
    let mut rest = text.as_str();
    let (head, body) = loop {
        let (head, body) = rest.split_once("\r\n\r\n").unwrap_or((rest, ""));
        match head.starts_with("HTTP/1.1 100") {
            true => rest = body,
            false => break (head, body),
        }
    };
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if status == 401 || status == 403 {
        return Err("it needs a sign-in, which Brigadier can't do yet".into());
    }
    if status >= 400 {
        return Err(format!(
            "HTTP {status}: {}",
            body.chars().take(300).collect::<String>()
        ));
    }
    for line in head.lines() {
        if let Some((k, v)) = line.split_once(':')
            && k.eq_ignore_ascii_case("mcp-session-id")
        {
            *session = Some(v.trim().to_string());
        }
    }
    let data = body.lines().filter_map(|l| l.strip_prefix("data:"));
    let found: Vec<Value> = match serde_json::from_str::<Value>(body.trim()) {
        Ok(Value::Array(all)) => all,
        Ok(v) => vec![v],
        Err(_) => data
            .filter_map(|d| serde_json::from_str(d.trim()).ok())
            .collect(),
    };
    Ok(found)
}
