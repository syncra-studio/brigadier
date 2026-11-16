//! The New tab's Local servers [D508]: the local addresses the session's steps printed, as the old
//! app's devServers read a terminal's output, kept while something still answers there.

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

/// Each server address its steps printed that answers now, newest first, one per origin.
pub fn of(dir: &Path) -> Vec<String> {
    let mut printed = vec![];
    // shortcut: steps' output only; a terminal's too once terminals are built [D361].
    let _ = brigadier_core::rewind::read_active(dir, |item| {
        if item["kind"] == "tool_done"
            && let Some(output) = item["output"].as_str()
            && output.contains("://")
        {
            printed.extend(addresses(&plain(output)));
        }
    });
    let mut origins = vec![];
    let mut found = vec![];
    for url in printed.into_iter().rev() {
        let origin = origin(&url).to_string();
        if !origins.contains(&origin) && answers(&origin) {
            found.push(url);
        }
        origins.push(origin);
    }
    found
}

/// `text` without its colours (`ESC [ … letter`).
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("\x1b[") {
        out.push_str(&rest[..at]);
        let after = &rest[at + 2..];
        let params = after
            .find(|c: char| !(c.is_ascii_digit() || c == ';'))
            .unwrap_or(after.len());
        rest = match after[params..].chars().next() {
            Some(c) if c.is_ascii_alphabetic() => &after[params + 1..],
            _ => {
                out.push_str("\x1b[");
                after
            }
        };
    }
    out.push_str(rest);
    out
}

/// A local server's host: `localhost`, `<name>.localhost`, `127.0.0.1`, `0.0.0.0` or `[::1]`.
fn local(host: &str) -> bool {
    let word = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    matches!(host, "localhost" | "127.0.0.1" | "0.0.0.0" | "[::1]")
        || host.strip_suffix(".localhost").is_some_and(word)
}

/// The local server addresses in `text`, as the old ADDRESS pattern found them:
/// `https?://<local host>[:port][/path]`, the path ending at a space, quote, `<`, `>` or `)`.
fn addresses(text: &str) -> Vec<String> {
    let mut found = vec![];
    let mut from = 0;
    while let Some(at) = text[from..].find("http").map(|i| from + i) {
        from = at + 4;
        let rest = &text[at..];
        let Some(after) = (rest.strip_prefix("https://")).or_else(|| rest.strip_prefix("http://"))
        else {
            continue;
        };
        let run = if after.starts_with("[::1]") {
            5
        } else {
            after
                .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')))
                .unwrap_or(after.len())
        };
        // A sentence's full stop after the host isn't the host's.
        let host = after[..run].trim_end_matches('.');
        if !local(host) {
            continue;
        }
        let mut end = host.len();
        if let Some(port) = after[end..].strip_prefix(':') {
            let digits = port
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(port.len());
            if digits > 0 {
                end += 1 + digits;
            }
        }
        if after[end..].starts_with('/') {
            end += after[end..]
                .find(|c: char| c.is_whitespace() || matches!(c, '\'' | '"' | '<' | '>' | ')'))
                .unwrap_or(after.len() - end);
        }
        let scheme = rest.len() - after.len();
        found.push(rest[..scheme + end].to_string());
        from = at + scheme + end;
    }
    found
}

/// `scheme://host[:port]` of an address.
fn origin(url: &str) -> &str {
    let start = url.find("://").map_or(0, |i| i + 3);
    url[start..].find('/').map_or(url, |i| &url[..start + i])
}

/// Whether something on this computer takes a connection on the origin's port.
fn answers(origin: &str) -> bool {
    let port = (origin.rsplit_once(':'))
        .and_then(|(_, p)| p.parse::<u16>().ok())
        .unwrap_or(if origin.starts_with("https") { 443 } else { 80 });
    // A name may be served on either loopback.
    [Ipv4Addr::LOCALHOST.into(), Ipv6Addr::LOCALHOST.into()]
        .into_iter()
        .any(|ip| {
            TcpStream::connect_timeout(&SocketAddr::new(ip, port), Duration::from_millis(200))
                .is_ok()
        })
}
