use std::fs::{self, File, Permissions, TryLockError};
use std::io::{self, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::time::Duration;
use std::{env, process, thread};

const APP_NAME: &str = "Brigadier";
const PROTOCOL_VERSION: u32 = 1;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

fn main() -> io::Result<()> {
    let home = env::home_dir().ok_or_else(|| io::Error::other("no home directory"))?;
    let dir = home.join("Library/Application Support").join(APP_NAME);
    fs::create_dir_all(&dir)?;
    fs::set_permissions(&dir, Permissions::from_mode(0o700))?;

    // The kernel frees this lock however a daemon dies, so whoever holds it owns the socket and two
    // daemons starting together can't replace each other's. Held until the process exits.
    let lock = File::create(dir.join("daemon.lock"))?;
    match lock.try_lock() {
        Err(TryLockError::WouldBlock) => return Ok(()),
        Err(TryLockError::Error(error)) => return Err(error),
        Ok(()) => {}
    }

    let socket = dir.join("daemon.sock");
    match fs::remove_file(&socket) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let listener = UnixListener::bind(&socket)?;
    fs::set_permissions(&socket, Permissions::from_mode(0o600))?;

    for stream in listener.incoming().flatten() {
        // A client that drops mid-handshake or mid-frame only ends its own connection.
        thread::spawn(move || serve(stream));
    }
    Ok(())
}

fn serve(mut stream: UnixStream) -> io::Result<()> {
    if peer_uid(&stream)? != unsafe { libc::geteuid() } {
        return Ok(());
    }

    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    let mut version = [0; 4];
    stream.read_exact(&mut version)?;
    stream.set_read_timeout(None)?;

    let version = u32::from_be_bytes(version);
    if version != PROTOCOL_VERSION {
        return write_frame(
            &mut stream,
            &format!(
                r#"{{"seq":1,"status":"refused","error":"protocol version mismatch: daemon speaks {PROTOCOL_VERSION}, client sent {version}"}}"#
            ),
        );
    }

    write_frame(
        &mut stream,
        &format!(
            r#"{{"seq":1,"status":"running","pid":{},"version":"{}"}}"#,
            process::id(),
            env!("CARGO_PKG_VERSION")
        ),
    )?;

    // Stay open until the client leaves: the close is how each side learns the other has gone.
    io::copy(&mut stream, &mut io::sink())?;
    Ok(())
}

fn write_frame(stream: &mut UnixStream, json: &str) -> io::Result<()> {
    let mut frame = (json.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(json.as_bytes());
    stream.write_all(&frame)
}

fn peer_uid(stream: &UnixStream) -> io::Result<libc::uid_t> {
    let (mut uid, mut gid) = (0, 0);
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(uid)
}
