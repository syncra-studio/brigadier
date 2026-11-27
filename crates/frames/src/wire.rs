//! The host protocol, frozen [D60]: owner-only socket, peer uid check, a 4-byte version handshake,
//! then length-prefixed JSON frames. After the handshake each request frame gets exactly one reply
//! frame. Unknown fields are ignored, so old and new builds can talk.
//!
//! Hosts outlive app updates, so a client must speak every version a live host could still be on,
//! v1 and its exact-match handshake included, for as long as such a host can be alive [D60]. A
//! change adds ops and fields only; an old host answers an unknown op with an error. How many
//! versions back a build keeps is not settled (proposed: current and previous).

use serde_json::{Value, json};
use std::fs::{self, Permissions};
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{SocketAddr, UnixListener, UnixStream};
use std::path::Path;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

pub const PROTOCOL_VERSION: u32 = 1;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MESSAGE: u32 = 64 << 20;

/// The ordered build number baked in at compile time: `pnpm start` uses the commit count, and a
/// release sets its own (proposed). A newer daemon replaces an older one by it; 0 means unset.
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
    let listener = at_path(path, |p| UnixListener::bind(p))?;
    fs::set_permissions(path, Permissions::from_mode(0o600))?;
    Ok(listener)
}

/// A temporary alias keeps the kernel's socket address short, while the socket itself stays in
/// its owning folder. No process-wide cwd changes: other threads may be opening files too.
fn at_path<T>(path: &Path, run: impl FnOnce(&Path) -> io::Result<T>) -> io::Result<T> {
    if SocketAddr::from_pathname(path).is_ok() {
        return run(path);
    }
    let short = || -> io::Result<T> {
        let name = path
            .file_name()
            .ok_or_else(|| io::Error::other("A local socket needs a file name."))?;
        let parent = path.parent().filter(|p| !p.as_os_str().is_empty());
        let parent = fs::canonicalize(parent.unwrap_or(Path::new(".")))?;
        let mut template = b"/tmp/brigadier-socket-XXXXXX\0".to_vec();
        if unsafe { libc::mkdtemp(template.as_mut_ptr().cast()) }.is_null() {
            return Err(io::Error::last_os_error());
        }
        let dir = Path::new(std::ffi::OsStr::from_bytes(&template[..template.len() - 1]));
        let alias = dir.join("d");
        let result = symlink(parent, &alias).and_then(|()| run(&alias.join(name)));
        let cleaned = fs::remove_dir_all(dir);
        result.and_then(|value| cleaned.map(|()| value))
    };
    short().map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("Couldn't open the local socket through a short path in /tmp: {e}"),
        )
    })
}

/// Opens a socket without a handshake, including one whose owning folder has a long path.
pub fn connect_socket(path: &Path) -> io::Result<UnixStream> {
    at_path(path, |p| UnixStream::connect(p))
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

#[cfg(target_os = "linux")]
fn peer_cred(stream: &UnixStream) -> io::Result<libc::ucred> {
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let at = (&mut cred as *mut libc::ucred).cast();
    let fd = stream.as_raw_fd();
    if unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_PEERCRED, at, &mut len) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(cred)
}

#[cfg(target_os = "linux")]
pub fn peer_uid(stream: &UnixStream) -> io::Result<libc::uid_t> {
    peer_cred(stream).map(|c| c.uid)
}

/// The pid of the process that connected.
#[cfg(target_os = "linux")]
pub fn peer_pid(stream: &UnixStream) -> io::Result<i32> {
    peer_cred(stream).map(|c| c.pid)
}

#[cfg(target_os = "macos")]
pub fn peer_uid(stream: &UnixStream) -> io::Result<libc::uid_t> {
    let (mut uid, mut gid) = (0, 0);
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(uid)
}

/// The pid of the process that connected.
#[cfg(target_os = "macos")]
pub fn peer_pid(stream: &UnixStream) -> io::Result<i32> {
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    let fd = stream.as_raw_fd();
    let at = (&mut pid as *mut libc::pid_t).cast();
    if unsafe { libc::getsockopt(fd, libc::SOL_LOCAL, libc::LOCAL_PEERPID, at, &mut len) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(pid)
}

/// The daemon's own protocol version (its handshake is the same as a host's).
pub const DAEMON_PROTOCOL: u32 = 4;

/// Connects to the daemon and handshakes, `timeout` bounding every read.
pub fn connect_daemon(path: &Path, timeout: Duration) -> io::Result<Conn> {
    connect_as(path, timeout, DAEMON_PROTOCOL)
}

pub struct Conn {
    pub stream: UnixStream,
    pub hello: Value,
}

/// Connects and handshakes. `timeout` bounds every read, so a frozen owner reads as an error,
/// never as a hang.
pub fn connect(path: &Path, timeout: Duration) -> io::Result<Conn> {
    connect_as(path, timeout, PROTOCOL_VERSION)
}

fn connect_as(path: &Path, timeout: Duration, version: u32) -> io::Result<Conn> {
    let mut stream = connect_socket(path)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    stream.write_all(&version.to_be_bytes())?;
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
