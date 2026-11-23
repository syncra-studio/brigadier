//! The session's MCP proxy [wave4 D2043]: each CLI reaches the library's remote servers at
//! `http://127.0.0.1:<port>/mcp/<name>` with this session's bearer, and the proxy forwards each
//! request upstream through the system's curl (its TLS; no HTTP client of our own), adding the
//! server's current token, which it asks the daemon for. The CLI never sees that token, so one
//! sign-in fixes every running session. It doesn't read MCP: any method goes, SSE streams through,
//! and every answer is close-delimited.
//!
//! It binds 127.0.0.1 only, checks Host, refuses any Origin, and needs the bearer (the old app's
//! CVE lessons, w07 §3). An upstream 401 gets one refresh from the daemon and one retry, then a
//! plain JSON-RPC error, and on a tool call a note in the session's log: the thread's Sign in.

mod tool_call;
mod unreached;
use brigadier_frames::wire;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::{fs, thread};

/// A request's head and body at most.
const HEAD_MAX: usize = 64 << 10;
const BODY_MAX: usize = 32 << 20;
/// Headers that belong to one hop, never forwarded either way.
const HOP: [&str; 12] = [
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "content-length",
    "te",
    "trailer",
    "upgrade",
    "proxy-authorization",
    "proxy-connection",
    "expect",
    "accept-encoding",
];

/// What the daemon last said a server is reached with: kept, so a daemon restart breaks nothing.
#[derive(Clone)]
struct Upstream {
    url: String,
    headers: Vec<(String, String)>,
    title: String,
}

struct Proxy {
    dir: PathBuf,
    port: u16,
    secret: String,
    known: Mutex<HashMap<String, Upstream>>,
    /// Servers whose sign-in the thread was already told about, till one answers again.
    told: Mutex<HashSet<String>>,
    note: Box<dyn Fn(&Value) + Send + Sync>,
}

/// Starts the proxy on `fd` (a listener a moving host passed through exec, so the port the CLIs
/// were given stays) or a new port, and writes `plugins/proxy.json`. Answers the listener's fd.
pub fn start(
    dir: &Path,
    fd: Option<i32>,
    note: Box<dyn Fn(&Value) + Send + Sync>,
) -> io::Result<i32> {
    let listener = match fd {
        // Close-on-exec again, so no child of this host holds the port past it.
        Some(fd) => unsafe {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
            TcpListener::from_raw_fd(fd)
        },
        None => TcpListener::bind(("127.0.0.1", 0))?,
    };
    let port = listener.local_addr()?.port();
    let file = dir.join("plugins").join("proxy.json");
    let kept: Value = fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    // A moved host keeps the secret its CLIs hold; a new one makes its own.
    let secret = match (fd, kept["port"] == port, kept["secret"].as_str()) {
        (Some(_), true, Some(s)) => s.to_string(),
        _ => random(),
    };
    fs::create_dir_all(file.parent().unwrap())?;
    let tmp = file.with_extension("tmp");
    let _ = fs::remove_file(&tmp);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?
        .write_all(
            json!({"port": port, "secret": secret})
                .to_string()
                .as_bytes(),
        )?;
    fs::rename(tmp, file)?;
    let raw = listener.as_raw_fd();
    let proxy = Arc::new(Proxy {
        dir: dir.into(),
        port,
        secret,
        known: Mutex::default(),
        told: Mutex::default(),
        note,
    });
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let proxy = proxy.clone();
            thread::spawn(move || {
                let _ = proxy.serve(stream);
            });
        }
    });
    Ok(raw)
}

fn random() -> String {
    let mut b = [0u8; 32];
    let _ = fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b));
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn answer(out: &mut TcpStream, status: &str, kind: &str, body: &str) -> io::Result<()> {
    write!(
        out,
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

impl Proxy {
    fn serve(&self, mut out: TcpStream) -> io::Result<()> {
        out.set_read_timeout(Some(Duration::from_secs(30)))?;
        let mut input = BufReader::new(out.try_clone()?);
        let (mut lines, mut size) = (vec![], 0);
        loop {
            let mut line = String::new();
            size += input.read_line(&mut line)?;
            if line.is_empty() || size > HEAD_MAX {
                return Ok(());
            }
            let line = line.trim_end().to_string();
            if line.is_empty() {
                break;
            }
            lines.push(line);
        }
        let mut first = lines[0].split_whitespace();
        let (method, target) = (
            first.next().unwrap_or("").to_string(),
            first.next().unwrap_or(""),
        );
        let headers: Vec<(String, String)> = (lines[1..].iter())
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
            .collect();
        let get = |k: &str| {
            headers
                .iter()
                .find(|(n, _)| n == k)
                .map(|(_, v)| v.as_str())
        };
        let host_ok = get("host").is_some_and(|h| {
            h == format!("127.0.0.1:{}", self.port) || h == format!("localhost:{}", self.port)
        });
        if !host_ok || get("origin").is_some() {
            return answer(&mut out, "403 Forbidden", "text/plain", "Refused.");
        }
        let bearer = get("authorization")
            .and_then(|a| a.strip_prefix("Bearer "))
            .unwrap_or("");
        if !same(bearer.as_bytes(), self.secret.as_bytes()) {
            return answer(&mut out, "403 Forbidden", "text/plain", "Refused.");
        }
        let path = target.split('?').next().unwrap_or("");
        let Some(name) = path.strip_prefix("/mcp/").filter(|n| {
            !n.is_empty()
                && n.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        }) else {
            return answer(&mut out, "404 Not Found", "text/plain", "No such server.");
        };
        let body = body(&mut input, get("content-length"), get("transfer-encoding"))?;
        let forwarded: Vec<(String, String)> = headers
            .iter()
            .filter(|(k, _)| {
                !HOP.contains(&k.as_str()) && k != "authorization" && k != "origin" && k != "cookie"
            })
            .cloned()
            .collect();
        let mut stale = None;
        for _ in 0..2 {
            let up = match self.upstream(name, stale.as_deref()) {
                Ok(up) => up,
                Err(why) => return self.refuse(&mut out, &method, &body, name, &why),
            };
            let (mut child, mut from, head) = curl(&self.dir, &method, &up, &forwarded, &body)?;
            let status: u16 = head
                .first()
                .and_then(|l| l.split_whitespace().nth(1)?.parse().ok())
                .unwrap_or(502);
            if status == 401 {
                let _ = child.kill();
                let _ = child.wait();
                stale = Some(
                    up.headers
                        .iter()
                        .find(|(k, _)| k.eq_ignore_ascii_case("authorization"))
                        .map_or(String::new(), |(_, v)| v.clone()),
                );
                continue;
            }
            unreached::note(&self.dir, name, &body, status / 100 != 2);
            if status / 100 == 2 {
                self.told.lock().unwrap().remove(name);
            }
            let reason = head
                .first()
                .map_or("", |l| l.splitn(3, ' ').nth(2).unwrap_or(""));
            let mut text = format!("HTTP/1.1 {status} {reason}\r\n");
            for (k, v) in head[1..].iter().filter_map(|l| l.split_once(':')) {
                if !HOP.contains(&k.trim().to_ascii_lowercase().as_str()) {
                    text.push_str(&format!("{}: {}\r\n", k.trim(), v.trim()));
                }
            }
            text.push_str("Connection: close\r\n\r\n");
            out.write_all(text.as_bytes())?;
            // Streams as it comes; a CLI that hangs up ends curl, even while the stream is quiet.
            let (mut peer, pid) = (out.try_clone()?, child.id() as i32);
            let gone = thread::spawn(move || {
                let mut b = [0u8; 256];
                loop {
                    match peer.read(&mut b) {
                        Ok(n) if n > 0 => {}
                        Err(e)
                            if matches!(
                                e.kind(),
                                io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                            ) => {}
                        _ => break,
                    }
                }
                // Not reaped until the wait below, so the pid is still curl's.
                unsafe { libc::kill(pid, libc::SIGTERM) };
            });
            let mut buf = [0u8; 16 << 10];
            loop {
                match from.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) if out.write_all(&buf[..n]).and_then(|_| out.flush()).is_err() => break,
                    Ok(_) => {}
                }
            }
            let _ = out.shutdown(std::net::Shutdown::Both);
            let _ = gone.join();
            let _ = child.kill();
            let _ = child.wait();
            return Ok(());
        }
        let why = format!(
            "{} needs sign-in in Brigadier (Settings › Plugins).",
            self.title(name)
        );
        self.refuse(&mut out, &method, &body, name, &why)
    }

    /// The server's plain name, as the daemon last gave it.
    fn title(&self, name: &str) -> String {
        let known = self.known.lock().unwrap();
        known
            .get(name)
            .map_or(name.to_string(), |u| u.title.clone())
    }

    /// The server's address and headers: the daemon's answer (a refresh when `stale` names the
    /// refused token), else the last one it gave.
    fn upstream(&self, name: &str, stale: Option<&str>) -> Result<Upstream, String> {
        let data = self
            .dir
            .parent()
            .and_then(Path::parent)
            .unwrap_or(Path::new("/"));
        let session = self.dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let ask =
            json!({"id": 1, "op": "upstream", "session": session, "server": name, "stale": stale});
        let reply = wire::connect_daemon(&data.join("daemon.sock"), Duration::from_secs(60))
            .and_then(|mut c| c.call(&ask));
        let reply = match reply {
            Ok(r) => r,
            Err(_) => {
                return self
                    .known
                    .lock()
                    .unwrap()
                    .get(name)
                    .cloned()
                    .filter(|_| stale.is_none())
                    .ok_or_else(|| {
                        "Brigadier isn't running, so this server can't be reached.".into()
                    });
            }
        };
        if reply["ok"] != true {
            return Err(reply["error"]
                .as_str()
                .unwrap_or("This server can't be reached.")
                .into());
        }
        let up = Upstream {
            url: reply["url"].as_str().unwrap_or("").into(),
            headers: (reply["headers"].as_object().into_iter().flatten())
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").into()))
                .collect(),
            title: reply["title"].as_str().unwrap_or(name).into(),
        };
        self.known.lock().unwrap().insert(name.into(), up.clone());
        Ok(up)
    }

    /// Answers a request the server can't take now with `why`: a JSON-RPC error for each request
    /// in a POST, so the agent reads the plain line, and no stream for a GET. Notes a tool call once.
    fn refuse(
        &self,
        out: &mut TcpStream,
        method: &str,
        body: &[u8],
        name: &str,
        why: &str,
    ) -> io::Result<()> {
        unreached::note(&self.dir, name, body, true);
        if tool_call::calls_tool(body) && self.told.lock().unwrap().insert(name.into()) {
            let title = self.title(name);
            (self.note)(
                &json!({"event": "sign_in", "server": name, "title": title, "message": why}),
            );
        }
        if method != "POST" {
            return answer(out, "405 Method Not Allowed", "text/plain", why);
        }
        let error = |id: &Value| json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32001, "message": why}});
        let reply = match serde_json::from_slice::<Value>(body).unwrap_or_default() {
            Value::Array(all) => Value::Array(
                all.iter()
                    .filter(|m| m.get("id").is_some())
                    .map(|m| error(&m["id"]))
                    .collect(),
            ),
            m if m.get("id").is_some() => error(&m["id"]),
            _ => return answer(out, "202 Accepted", "text/plain", ""),
        };
        answer(out, "200 OK", "application/json", &reply.to_string())
    }
}

/// Equal, in time that doesn't depend on where they differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |d, (x, y)| d | (x ^ y)) == 0
}

/// The request's body: by its length, or its chunks.
fn body(
    input: &mut BufReader<TcpStream>,
    length: Option<&str>,
    coding: Option<&str>,
) -> io::Result<Vec<u8>> {
    let mut body = vec![];
    if coding.is_some_and(|c| c.eq_ignore_ascii_case("chunked")) {
        loop {
            let mut line = String::new();
            input.read_line(&mut line)?;
            let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or(""), 16)
                .map_err(io::Error::other)?;
            if size == 0 || body.len() + size > BODY_MAX {
                // The trailer, if any, to its blank line.
                while input.read_line(&mut line)? > 2 {
                    line.clear();
                }
                return Ok(body);
            }
            let at = body.len();
            body.resize(at + size + 2, 0);
            input.read_exact(&mut body[at..])?;
            body.truncate(at + size);
        }
    }
    let n: usize = length.and_then(|l| l.parse().ok()).unwrap_or(0);
    if n > BODY_MAX {
        return Err(io::Error::other("too big"));
    }
    body.resize(n, 0);
    input.read_exact(&mut body)?;
    Ok(body)
}

/// One request upstream through curl: its process, its output past the head, and the head's lines.
/// The headers go in a 0600 file, so no token shows in the process list; it goes once curl has read it.
fn curl(
    dir: &Path,
    method: &str,
    up: &Upstream,
    forwarded: &[(String, String)],
    body: &[u8],
) -> io::Result<(Child, BufReader<ChildStdout>, Vec<String>)> {
    let file = dir.join("plugins").join(format!("h-{}", &random()[..16]));
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&file)?;
    for (k, v) in forwarded.iter().chain(&up.headers) {
        writeln!(f, "{k}: {v}")?;
    }
    drop(f);
    let mut c = Command::new("/usr/bin/curl");
    c.args([
        "-sS",
        "--suppress-connect-headers",
        "-N",
        "-D",
        "-",
        "--connect-timeout",
        "20",
        "-X",
        method,
    ])
    .args([
        "-H".into(),
        format!("@{}", file.display()),
        "-H".into(),
        "Expect:".into(),
    ]);
    if !body.is_empty() {
        c.args(["--data-binary", "@-"]);
    }
    let child = c
        .arg("--")
        .arg(&up.url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            let _ = fs::remove_file(&file);
            return Err(e);
        }
    };
    let mut stdin = child.stdin.take().unwrap();
    let body = body.to_vec();
    thread::spawn(move || {
        let _ = stdin.write_all(&body);
    });
    let mut from = BufReader::new(child.stdout.take().unwrap());
    let mut head = vec![];
    loop {
        let mut line = String::new();
        if from.read_line(&mut line)? == 0 {
            break;
        }
        let line = line.trim_end().to_string();
        match line.is_empty() {
            // An interim 1xx head is passed by.
            true if head.first().is_some_and(|l: &String| {
                l.split_whitespace()
                    .nth(1)
                    .is_some_and(|s| s.starts_with('1'))
            }) =>
            {
                head.clear()
            }
            true => break,
            false => head.push(line),
        }
    }
    let _ = fs::remove_file(&file);
    if head.is_empty() {
        head.push("HTTP/1.1 502 Bad Gateway".into());
    }
    Ok((child, from, head))
}

/// The listener's fd, kept open across a move's exec.
pub fn keep(fd: i32) {
    unsafe { libc::fcntl(fd, libc::F_SETFD, 0) };
}

/// Closes on exec again, after a move that failed.
pub fn unkeep(fd: i32) {
    unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
}
