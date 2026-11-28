//! Starts `brigadier-remote` beside this daemon's program, under its Seatbelt profile, with fd 3
//! its end of a socket pair and fd 4 the TCP listener bound here on every interface, at the port
//! last used (`data/remote/port`) or a free one. Frames on the pair are `[stream u32][kind u8]
//! [len u16][bytes]`: kind 0 data, 1 a peer's opening (its address), 2 a close; each goes to
//! `link` under the remote state's lock. Stream 0 is the relay's: kind 4 names it to the gateway,
//! kind 5 carries its control frames; its phone streams have the top bit set.

use super::{STATE, State, bonjour, link};
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::net::TcpListener;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::{fs, thread};

const PROFILE: &str = include_str!("../../../remote-gateway/sandbox.sb");
pub(super) const DATA: u8 = 0;
pub(super) const OPEN: u8 = 1;
pub(super) const CLOSE: u8 = 2;
pub(super) const RELAY: u8 = 4;
pub(super) const CONTROL: u8 = 5;
/// One push: the push sender's signed URL, a newline and its text down; its answer up.
pub(super) const PUSH: u8 = 6;
/// A relay phone stream's id has this bit set.
pub(super) const TOP: u32 = 1 << 31;
/// Proposed: a gateway that takes no frame for this long is stuck, and is started again: the
/// daemon never waits on it with the remote state locked for longer.
const STUCK: Duration = Duration::from_secs(5);

pub(super) struct Gateway {
    child: Child,
    pub(super) port: u16,
    pub(super) out: Arc<Mutex<UnixStream>>,
    pub(super) bonjour: bonjour::Registration,
    /// Whether the TXT record says an offer is open.
    pub(super) open: bool,
}

impl Gateway {
    pub(super) fn pid(&self) -> i32 {
        self.child.id() as i32
    }

    pub(super) fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(super) fn start(data: &Path, public: &[u8]) -> io::Result<Gateway> {
    // Seatbelt matches the real path, so the program is named by it.
    let program = fs::canonicalize(std::env::current_exe()?.with_file_name("brigadier-remote"))?;
    let saved = data.join("remote/port");
    let last = fs::read_to_string(&saved)
        .ok()
        .and_then(|p| p.trim().parse().ok());
    // `::` takes IPv4 too: macOS sockets aren't IPv6-only unless asked.
    let listener = match last.map(|p: u16| TcpListener::bind(("::", p))) {
        Some(Ok(listener)) => listener,
        _ => TcpListener::bind(("::", 0))?,
    };
    let port = listener.local_addr()?.port();
    if last != Some(port) {
        brigadier_core::write_atomic(&saved, port.to_string().as_bytes())?;
    }
    let (ours, theirs) = UnixStream::pair()?;
    let fds = [theirs.as_raw_fd(), listener.as_raw_fd()];
    let mut profile = PROFILE.to_string();
    if super::relay::dev() {
        profile += "(allow network-outbound (remote ip \"localhost:*\"))\n";
    }
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .arg("-D")
        .arg(format!("GATEWAY={}", program.display()))
        .args(["-p", &profile])
        .arg(&program)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null());
    // Above 9 first, so placing one at 3 or 4 never overwrites the other; dup2 clears close-on-exec.
    unsafe {
        command.pre_exec(move || {
            for (fd, to) in fds.into_iter().zip([3, 4]) {
                let high = libc::fcntl(fd, libc::F_DUPFD, 10);
                if high < 0 || libc::dup2(high, to) < 0 {
                    return Err(io::Error::last_os_error());
                }
                libc::close(high);
            }
            Ok(())
        })
    };
    let child = command.spawn()?;
    let bonjour = bonjour::register(port, &bonjour::txt(public, false))?;
    let out = ours.try_clone()?;
    out.set_write_timeout(Some(STUCK))?;
    let out = Arc::new(Mutex::new(out));
    thread::spawn(move || pump(ours));
    Ok(Gateway {
        child,
        port,
        out,
        bonjour,
        open: false,
    })
}

/// One frame to the gateway; a gateway that's gone or stuck drops it and is cut off, and the
/// pass starts another.
pub(super) fn send(s: &State, stream: u32, kind: u8, bytes: &[u8]) {
    let mut frame = Vec::with_capacity(7 + bytes.len());
    frame.extend(stream.to_be_bytes());
    frame.push(kind);
    frame.extend((bytes.len() as u16).to_be_bytes());
    frame.extend(bytes);
    if let Some(out) = &s.out {
        let out = out.lock().unwrap();
        if (&*out).write_all(&frame).is_err() {
            let _ = out.shutdown(Shutdown::Both);
        }
    }
}

/// The gateway's frames, until it goes.
fn pump(mut from: UnixStream) {
    let mut head = [0; 7];
    while from.read_exact(&mut head).is_ok() {
        let stream = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
        let mut bytes = vec![0; u16::from_be_bytes([head[5], head[6]]) as usize];
        if from.read_exact(&mut bytes).is_err() {
            break;
        }
        link::frame(&mut STATE.lock().unwrap(), stream, head[4], &bytes);
    }
}
