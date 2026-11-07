//! The skeleton's socket protocol, unchanged: owner-only socket, peer uid check, a 4-byte version
//! handshake, then length-prefixed JSON frames. After the handshake each request frame gets exactly
//! one reply frame. Unknown fields are ignored, so old and new builds can talk.

use serde_json::{Value, json};
use std::fs::{self, Permissions};
use std::io::{self, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

pub const PROTOCOL_VERSION: u32 = 1;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MESSAGE: u32 = 64 << 20;

/// The build number baked in at compile time, so the drills can tell versions apart.
pub fn build() -> u32 {
    option_env!("BRIGADIER_BUILD")
        .and_then(|b| b.parse().ok())
        .unwrap_or(0)
}

/// Binds the socket. Call only while holding the lock that owns it, so a live owner's socket is
/// never replaced.
pub fn bind(path: &Path) -> io::Result<UnixListener> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let listener = UnixListener::bind(path)?;
    fs::set_permissions(path, Permissions::from_mode(0o600))?;
    Ok(listener)
}

pub fn serve<F>(listener: UnixListener, handler: Arc<F>)
where
    F: Fn(&Value) -> Value + Send + Sync + 'static,
{
    for stream in listener.incoming().flatten() {
        let handler = handler.clone();
        // A client that drops mid-handshake or mid-frame only ends its own connection.
        let _ = thread::Builder::new()
            .stack_size(256 << 10)
            .spawn(move || serve_one(stream, &*handler));
    }
}

fn serve_one<F: Fn(&Value) -> Value>(mut stream: UnixStream, handler: &F) -> io::Result<()> {
    if peer_uid(&stream)? != unsafe { libc::geteuid() } {
        return Ok(());
    }
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    let mut version = [0; 4];
    stream.read_exact(&mut version)?;
    stream.set_read_timeout(None)?;
    let version = u32::from_be_bytes(version);
    if version != PROTOCOL_VERSION {
        let refused = json!({"seq": 1, "status": "refused", "error": format!("protocol version mismatch: owner speaks {PROTOCOL_VERSION}, client sent {version}")});
        return write_frame(&mut stream, &refused.to_string());
    }
    let hello = json!({"seq": 1, "status": "running", "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION"), "build": build()});
    write_frame(&mut stream, &hello.to_string())?;
    loop {
        let request = match read_frame(&mut stream) {
            Ok(text) => serde_json::from_str(&text).unwrap_or(Value::Null),
            Err(_) => return Ok(()),
        };
        write_frame(&mut stream, &handler(&request).to_string())?;
    }
}

pub fn write_frame(stream: &mut UnixStream, json: &str) -> io::Result<()> {
    let mut frame = (json.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(json.as_bytes());
    stream.write_all(&frame)
}

pub fn read_frame(stream: &mut UnixStream) -> io::Result<String> {
    let mut len = [0; 4];
    stream.read_exact(&mut len)?;
    let len = u32::from_be_bytes(len);
    if len > MAX_MESSAGE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "message too large",
        ));
    }
    let mut data = vec![0; len as usize];
    stream.read_exact(&mut data)?;
    String::from_utf8(data).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

pub fn peer_uid(stream: &UnixStream) -> io::Result<libc::uid_t> {
    let (mut uid, mut gid) = (0, 0);
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(uid)
}

pub struct Conn {
    stream: UnixStream,
    pub hello: Value,
}

/// Connects and handshakes. `timeout` bounds every read, so a frozen owner reads as an error,
/// never as a hang.
pub fn connect(path: &Path, timeout: Duration) -> io::Result<Conn> {
    let mut stream = UnixStream::connect(path)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    stream.write_all(&PROTOCOL_VERSION.to_be_bytes())?;
    let hello: Value = serde_json::from_str(&read_frame(&mut stream)?)?;
    if hello["status"] != "running" {
        return Err(io::Error::other(
            hello["error"].as_str().unwrap_or("refused").to_string(),
        ));
    }
    Ok(Conn { stream, hello })
}

impl Conn {
    pub fn call(&mut self, request: &Value) -> io::Result<Value> {
        write_frame(&mut self.stream, &request.to_string())?;
        Ok(serde_json::from_str(&read_frame(&mut self.stream)?)?)
    }

    pub fn set_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
        self.stream.set_read_timeout(timeout)
    }
}
