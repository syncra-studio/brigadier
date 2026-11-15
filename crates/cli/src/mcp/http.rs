//! MCP's Streamable HTTP transport, one POST at a time.

use serde_json::{Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// A server's refusal of what it was sent with; a library one's sign-in is retried once on it.
pub(super) const REFUSED: &str = "it needs a sign-in that only its own agent holds";

/// One Streamable HTTP POST through the system's curl (its TLS; no client of our own): the answers
/// in its JSON or event-stream body, its session id kept.
fn post(
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
        return Err(REFUSED.into());
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

/// One POST; a library server's (`signed`: its data folder, key and the Authorization last sent)
/// with its current key or token each time, so a sign-out or sign-in holds at once, and on a
/// refusal one refresh by the daemon and one retry [D417].
pub(super) fn send(
    url: &str,
    headers: &Option<PathBuf>,
    session: &mut Option<String>,
    signed: &mut Option<(PathBuf, String, Option<String>)>,
    msg: &Value,
    wait: Duration,
) -> Result<Vec<Value>, String> {
    // A server re-added at another address: its credentials never go to the old one.
    let reach = |data: &PathBuf, key: &str, stale: Option<&str>| {
        let (now, h, title) = crate::signin::reach(data, key, stale)?;
        match now == url {
            true => Ok((h, title)),
            false => Err("its address changed; call it again".to_string()),
        }
    };
    if let Some((data, key, used)) = signed.as_mut() {
        renew(headers, used, &reach(data, key, None)?.0)?;
    }
    let r = post(url, headers.as_deref(), session, msg, wait);
    let refused = r.as_ref().is_err_and(|e| e == REFUSED);
    let Some((data, key, used)) = signed.as_mut().filter(|_| refused) else {
        return r;
    };
    let (h, title) = reach(data, key, used.as_deref())?;
    renew(headers, used, &h)?;
    post(url, headers.as_deref(), session, msg, wait).map_err(|e| match e == REFUSED {
        true => format!("{title} needs sign-in in Brigadier (Settings › Plugins)."),
        false => e,
    })
}

/// Rewrites a library server's headers file when its Authorization changed.
fn renew(
    file: &Option<PathBuf>,
    used: &mut Option<String>,
    h: &Map<String, Value>,
) -> Result<(), String> {
    let now = h
        .get("Authorization")
        .and_then(Value::as_str)
        .map(String::from);
    if now != *used {
        if let Some(path) = file {
            std::fs::write(path, lines(h)).map_err(|e| e.to_string())?;
        }
        *used = now;
    }
    Ok(())
}

/// Headers as curl's `@file` takes them.
pub(super) fn lines(h: &Map<String, Value>) -> String {
    h.iter()
        .map(|(k, v)| format!("{k}: {}\n", v.as_str().unwrap_or("")))
        .collect()
}
