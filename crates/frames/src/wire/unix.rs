//! Unix sockets: owner-only, with the peer's uid and pid from the kernel.

use std::fs::{self, Permissions};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{SocketAddr, UnixListener, UnixStream};
use std::path::Path;

pub type Stream = UnixStream;
pub type Listener = UnixListener;

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

/// The peer runs as this user.
pub fn same_user(stream: &UnixStream) -> io::Result<bool> {
    Ok(peer_uid(stream)? == unsafe { libc::geteuid() })
}
