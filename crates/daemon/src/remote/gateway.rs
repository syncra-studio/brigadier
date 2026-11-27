//! Starts `brigadier-remote` beside this daemon's program, under its Seatbelt profile, with fd 3
//! its end of a socket pair and fd 4 the TCP listener bound here on every interface, at the port
//! last used (`data/remote/port`) or a free one. Frames on the pair are `[stream u32][kind u8]
//! [len u16][bytes]`: kind 0 data, 1 a peer's opening (its address), 2 a close.

use super::bonjour;
use std::io::{self, Read, Write};
use std::net::TcpListener;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::{fs, thread};

const PROFILE: &str = include_str!("../../../remote-gateway/sandbox.sb");
const DATA: u8 = 0;
const CLOSE: u8 = 2;

pub(super) struct Gateway {
    child: Child,
    pub(super) port: u16,
    _bonjour: bonjour::Registration,
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

pub(super) fn start(data: &Path) -> io::Result<Gateway> {
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
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .arg("-D")
        .arg(format!("GATEWAY={}", program.display()))
        .args(["-p", PROFILE])
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
    let bonjour = bonjour::register(port)?;
    let writer = Arc::new(Mutex::new(ours.try_clone()?));
    thread::spawn(move || pump(ours, &writer));
    Ok(Gateway {
        child,
        port,
        _bonjour: bonjour,
    })
}

fn send(to: &Mutex<UnixStream>, stream: u32, kind: u8, bytes: &[u8]) -> io::Result<()> {
    let mut frame = Vec::with_capacity(7 + bytes.len());
    frame.extend(stream.to_be_bytes());
    frame.push(kind);
    frame.extend((bytes.len() as u16).to_be_bytes());
    frame.extend(bytes);
    to.lock().unwrap().write_all(&frame)
}

/// The gateway's frames, until it goes. Nothing is served yet: every peer is told "not yet".
fn pump(mut from: UnixStream, to: &Mutex<UnixStream>) {
    let mut head = [0; 7];
    while from.read_exact(&mut head).is_ok() {
        let stream = u32::from_be_bytes([head[0], head[1], head[2], head[3]]);
        let mut bytes = vec![0; u16::from_be_bytes([head[5], head[6]]) as usize];
        if from.read_exact(&mut bytes).is_err() {
            break;
        }
        if head[4] == DATA {
            let _ = send(to, stream, DATA, b"not yet");
            let _ = send(to, stream, CLOSE, &[]);
        }
    }
}
