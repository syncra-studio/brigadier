//! OAuth 2.1 for MCP servers, the old app's post-#789/#853 client over the system's curl: RFC 9728
//! then RFC 8414 discovery with tolerant `resource` matching, PKCE S256, registration in the
//! spec's order (pre-registered, CIMD, DCR), and token requests that tell a refusal from an outage.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::process::{Command, Stdio};

/// A pre-registered public client: GitHub offers neither CIMD nor DCR [wave4 D2045, D312].
const GITHUB: &str = "https://github.com/login/oauth";

/// Brigadier's GitHub OAuth app, public with no secret [D312, D438]; the environment's wins, and an
/// empty one turns GitHub sign-in off.
fn github_client() -> Option<String> {
    let id = std::env::var("BRIGADIER_GITHUB_CLIENT_ID");
    Some(id.unwrap_or_else(|_| "Ov23lijQ8PbCwmourxws".into())).filter(|v| !v.is_empty())
}

/// Brigadier's client metadata document on brigadier.sh [D312, D439]; the environment's wins, and an
/// empty one turns CIMD off.
fn cimd() -> Option<String> {
    let doc = std::env::var("BRIGADIER_CLIENT_METADATA_URL");
    Some(doc.unwrap_or_else(|_| "https://brigadier.sh/oauth/client.json".into()))
        .filter(|d| d.starts_with("https://"))
}

pub(super) struct Reply {
    pub status: u16,
    pub head: String,
    pub body: String,
}

impl Reply {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
    pub fn header(&self, name: &str) -> Option<&str> {
        (self.head.lines()).find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
        })
    }
}

/// One request through the system's curl, its body on stdin, so no secret is in the process list.
pub(super) fn fetch(
    method: &str,
    url: &str,
    kind: Option<&str>,
    body: &str,
) -> Result<Reply, String> {
    let mut c = Command::new(brigadier_frames::curl());
    c.args([
        "-sS",
        "--suppress-connect-headers",
        "-D",
        "-",
        "--max-time",
        "30",
        "-X",
        method,
    ])
    .args(["-H", "Accept: application/json, text/event-stream"]);
    if let Some(kind) = kind {
        c.args(["-H".into(), format!("Content-Type: {kind}")])
            .args(["--data-binary", "@-"]);
    }
    let mut child = (c.arg("--").arg(url))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let _ = child.stdin.take().unwrap().write_all(body.as_bytes());
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let (status, head, body) = split(&text);
    Ok(Reply {
        status,
        head: head.into(),
        body: body.into(),
    })
}

/// A response's status, head and body, past any interim `1xx` heads.
pub fn split(mut text: &str) -> (u16, &str, &str) {
    loop {
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text, ""));
        let status = (head.split_whitespace().nth(1)).and_then(|s| s.parse().ok());
        match status {
            Some(s @ 100..=199) if s != 101 => text = body,
            s => return (s.unwrap_or(0), head, body),
        }
    }
}

/// An endpoint Brigadier may talk OAuth to: https, or http on this Mac only; no user part.
pub fn check(url: &str) -> Result<(), String> {
    let (scheme, rest) = url.split_once("://").ok_or("Invalid OAuth URL")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit_once(':').map_or(authority, |(h, p)| {
        if p.chars().all(|c| c.is_ascii_digit()) {
            h
        } else {
            authority
        }
    });
    let local = matches!(host, "127.0.0.1" | "localhost" | "[::1]");
    if authority.is_empty()
        || authority.contains('@')
        || url.contains('#')
        || url.contains(char::is_whitespace)
    {
        return Err("Invalid OAuth URL".into());
    }
    match scheme {
        "https" => Ok(()),
        "http" if local => Ok(()),
        _ => Err("OAuth needs HTTPS".into()),
    }
}

/// `scheme://authority` and the path of a checked URL.
fn parts(url: &str) -> (&str, &str) {
    let at = url.find("://").map_or(0, |i| i + 3);
    let end = url[at..].find(['/', '?']).map_or(url.len(), |i| at + i);
    let path = url[end..].split('?').next().unwrap_or("");
    (&url[..end], path)
}

/// Whether metadata naming `advertised` may speak for the server at `server`: the same URL, or a
/// whole-segment parent on the same origin (#853). Anything wider would hand it another's tokens.
pub fn covers(advertised: &str, server: &str) -> bool {
    let ((ao, ap), (so, sp)) = (parts(advertised), parts(server));
    let (ap, sp) = (ap.trim_end_matches('/'), sp.trim_end_matches('/'));
    !advertised.contains('?')
        && ao.eq_ignore_ascii_case(so)
        && sp
            .strip_prefix(ap)
            .is_some_and(|r| r.is_empty() || r.starts_with('/'))
}

pub fn random() -> String {
    let mut b = [0u8; 32];
    let _ = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b));
    base64url(&b)
}

pub fn challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

fn base64url(bytes: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut s = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..=c.len() {
            s.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    s
}

/// `application/x-www-form-urlencoded`, for a query or a token request.
pub fn form(pairs: &[(&str, &str)]) -> String {
    let enc = |s: &str| -> String {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect()
    };
    let pairs = pairs.iter().filter(|(_, v)| !v.is_empty());
    pairs
        .map(|(k, v)| format!("{}={}", enc(k), enc(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// A query's value, decoded.
pub fn query(q: &str, name: &str) -> Option<String> {
    let v = q
        .split('&')
        .find_map(|p| p.strip_prefix(name)?.strip_prefix('='))?;
    let (mut out, b) = (vec![], v.as_bytes());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
                out.push(
                    hex.and_then(|h| u8::from_str_radix(h, 16).ok())
                        .unwrap_or(b'?'),
                );
                i += 2;
            }
            b'+' => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// A Bearer challenge's parameter; quoted URL values hold no commas.
fn parameter(header: &str, name: &str) -> Option<String> {
    header.split(',').find_map(|part| {
        let part = part.trim();
        let part = part.strip_prefix("Bearer ").unwrap_or(part);
        let (k, v) = part.split_once('=')?;
        (k.trim() == name).then(|| v.trim().trim_matches('"').to_string())
    })
}

/// What sign-in needs from a server, found by its metadata.
pub(super) struct Found {
    /// The authorization server's metadata.
    pub meta: Value,
    pub issuer: String,
    /// The metadata's `resource` as written, sent as the OAuth `resource`.
    pub resource: String,
    pub scope: String,
}

/// Whether the server at `server` takes OAuth: None when it answers without a sign-in.
pub(super) fn discover(server: &str) -> Result<Option<Found>, String> {
    check(server)?;
    let hello = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18",
        "capabilities": {}, "clientInfo": {"name": "brigadier", "version": env!("CARGO_PKG_VERSION")}}});
    let probe = fetch("POST", server, Some("application/json"), &hello.to_string())
        .map_err(|_| "Brigadier can't reach this server.")?;
    if probe.status != 401 && probe.status != 403 {
        return Ok(None);
    }
    let challenge = probe.header("www-authenticate").unwrap_or("").to_string();
    let (origin, path) = parts(server);
    let path = path.trim_end_matches('/');
    let mut tries: Vec<String> = parameter(&challenge, "resource_metadata")
        .into_iter()
        .collect();
    tries.push(format!(
        "{origin}/.well-known/oauth-protected-resource{path}"
    ));
    tries.push(format!("{origin}/.well-known/oauth-protected-resource"));
    let protected = tries
        .iter()
        .filter(|u| check(u).is_ok())
        .find_map(|u| {
            fetch("GET", u, None, "")
                .ok()
                .filter(|r| r.status == 200)
                .map(|r| r.json())
        })
        .filter(|m| m["resource"].is_string())
        .ok_or("This server gives no sign-in metadata.")?;
    let resource = protected["resource"].as_str().unwrap_or("").to_string();
    if !covers(&resource, server) {
        return Err("This server's sign-in metadata names another server.".into());
    }
    let issuer = protected["authorization_servers"][0]
        .as_str()
        .ok_or("This server names no sign-in server.")?;
    check(issuer)?;
    let (io, ip) = parts(issuer);
    let ip = ip.trim_end_matches('/');
    let tries = [
        format!("{io}/.well-known/oauth-authorization-server{ip}"),
        format!("{io}/.well-known/openid-configuration{ip}"),
        format!(
            "{}/.well-known/openid-configuration",
            issuer.trim_end_matches('/')
        ),
    ];
    for t in &tries {
        let Some(meta) = fetch("GET", t, None, "")
            .ok()
            .filter(|r| r.status == 200)
            .map(|r| r.json())
        else {
            continue;
        };
        if meta["issuer"].as_str().map(|i| i.trim_end_matches('/'))
            != Some(issuer.trim_end_matches('/'))
        {
            continue;
        }
        let urls = [
            "authorization_endpoint",
            "token_endpoint",
            "registration_endpoint",
            "revocation_endpoint",
            "device_authorization_endpoint",
        ];
        for k in urls {
            if let Some(u) = meta[k].as_str() {
                check(u)?;
            }
        }
        if !meta["token_endpoint"].is_string() {
            continue;
        }
        let s256 = (meta["code_challenge_methods_supported"]
            .as_array()
            .into_iter()
            .flatten())
        .any(|m| m == "S256");
        if !s256 {
            return Err("This server's sign-in doesn't support PKCE.".into());
        }
        let scopes = protected["scopes_supported"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str);
        let scope =
            parameter(&challenge, "scope").unwrap_or_else(|| scopes.collect::<Vec<_>>().join(" "));
        return Ok(Some(Found {
            issuer: meta["issuer"].as_str().unwrap_or(issuer).into(),
            meta,
            resource,
            scope,
        }));
    }
    Err("This server's sign-in server gives no metadata.".into())
}

/// A client Brigadier signs in as.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(super) struct Client {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    /// The loopback redirect it was registered with; empty when any loopback port goes.
    #[serde(default)]
    pub redirect: String,
    /// Pre-registered without a secret: the device flow (RFC 8628) instead of a redirect.
    #[serde(default)]
    pub device: bool,
}

/// Whether Brigadier can sign in to this server at all, without registering yet.
pub(super) fn registers(found: &Found) -> bool {
    let meta = &found.meta;
    match found.issuer.trim_end_matches('/') == GITHUB {
        true => github_client().is_some() && meta["device_authorization_endpoint"].is_string(),
        false => {
            meta["registration_endpoint"].is_string()
                || meta["client_id_metadata_document_supported"] == true && cimd().is_some()
        }
    }
}

/// The client for this issuer, in the spec's order: pre-registered, then CIMD, then DCR with
/// `redirect`; None when the server takes none of them, so each agent signs in itself [wave4 D2045].
pub(super) fn register(found: &Found, redirect: &str) -> Result<Option<Client>, String> {
    let meta = &found.meta;
    if found.issuer.trim_end_matches('/') == GITHUB {
        let id = github_client();
        let device = meta["device_authorization_endpoint"].is_string();
        return Ok(id.filter(|_| device).map(|id| Client {
            id,
            secret: None,
            redirect: String::new(),
            device,
        }));
    }
    if meta["client_id_metadata_document_supported"] == true
        && let Some(doc) = cimd()
    {
        return Ok(Some(Client {
            id: doc,
            secret: None,
            redirect: String::new(),
            device: false,
        }));
    }
    let Some(endpoint) = meta["registration_endpoint"].as_str() else {
        return Ok(None);
    };
    let ask = json!({"client_name": "Brigadier", "redirect_uris": [redirect], "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"], "token_endpoint_auth_method": "none"});
    let r = fetch("POST", endpoint, Some("application/json"), &ask.to_string())
        .map_err(|_| "Brigadier can't reach this server's sign-in.")?;
    if matches!(r.status, 400 | 401 | 403 | 405) {
        return Ok(None);
    }
    let v = r.json();
    match v["client_id"]
        .as_str()
        .filter(|id| r.status / 100 == 2 && !id.is_empty())
    {
        Some(id) => Ok(Some(Client {
            id: id.into(),
            secret: v["client_secret"].as_str().map(String::from),
            redirect: redirect.into(),
            device: false,
        })),
        None => Err("This server's sign-in didn't register Brigadier.".into()),
    }
}

/// Why a token request gave no token.
pub(super) enum Failed {
    /// RFC 6749 §5.2 `invalid_grant`, `invalid_client` or `unauthorized_client`: only a new sign-in helps.
    Rejected,
    /// No answer, a 5xx or 429, a gateway's page: the grant may still be good, so try again later.
    Unreachable,
    /// The device flow's `authorization_pending` or `slow_down`.
    Pending(bool),
}

/// A token request; `form` is the grant's own part. The new tokens, as the server answered.
pub(super) fn token(
    endpoint: &str,
    client: &Client,
    resource: &str,
    form_pairs: &[(&str, &str)],
) -> Result<Value, Failed> {
    let mut pairs = form_pairs.to_vec();
    pairs.push(("client_id", &client.id));
    if !client.device {
        pairs.push(("resource", resource));
    }
    if let Some(s) = &client.secret {
        pairs.push(("client_secret", s));
    }
    let r = fetch(
        "POST",
        endpoint,
        Some("application/x-www-form-urlencoded"),
        &form(&pairs),
    )
    .map_err(|_| Failed::Unreachable)?;
    let v = r.json();
    // GitHub answers its errors with a 200.
    match v["error"].as_str() {
        Some(
            "invalid_grant"
            | "invalid_client"
            | "unauthorized_client"
            | "access_denied"
            | "expired_token",
        ) => Err(Failed::Rejected),
        Some("authorization_pending") => Err(Failed::Pending(false)),
        Some("slow_down") => Err(Failed::Pending(true)),
        _ if r.status / 100 != 2 => Err(Failed::Unreachable),
        _ => {
            let bearer = v["token_type"]
                .as_str()
                .is_some_and(|t| t.eq_ignore_ascii_case("bearer"));
            match v["access_token"]
                .as_str()
                .filter(|t| bearer && !t.is_empty())
            {
                Some(_) => Ok(v),
                None => Err(Failed::Unreachable),
            }
        }
    }
}
