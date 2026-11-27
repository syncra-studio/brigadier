//! `brigadier-remote`: the phone gateway (remote design §4). The daemon starts it under
//! `sandbox.sb` with two inherited descriptors: 3, its end of a socket pair to the daemon, and 4,
//! the TCP listener the daemon bound. It holds no keys and parses nothing: it passes each peer's
//! length-prefixed messages (2-byte length, as Noise frames them) to the daemon as
//! `[stream u32][kind u8][len u16][bytes]`, and the daemon's back, dropping any peer that isn't
//! on a private, link-local or Tailscale address before a byte reaches the daemon. It ends when
//! the daemon does.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Shutdown, TcpListener, TcpStream};
use std::os::unix::io::FromRawFd;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const DATA: u8 = 0;
const OPEN: u8 = 1;
const CLOSE: u8 = 2;
/// Proposed: phones and pairing attempts at once; the daemon limits per source on top.
const MAX_STREAMS: usize = 32;
/// Proposed: how long a new peer has to send its first message.
const FIRST: Duration = Duration::from_secs(10);

type Peers = Arc<Mutex<HashMap<u32, TcpStream>>>;
type Daemon = Arc<Mutex<UnixStream>>;

fn main() {
    let (daemon, listener) = unsafe { (UnixStream::from_raw_fd(3), TcpListener::from_raw_fd(4)) };
    let peers: Peers = Arc::default();
    let reader = daemon.try_clone().unwrap_or_else(|_| std::process::exit(1));
    let daemon: Daemon = Arc::new(Mutex::new(daemon));
    {
        let (daemon, peers) = (daemon.clone(), peers.clone());
        thread::spawn(move || accept(listener, &daemon, &peers));
    }
    let _ = from_daemon(reader, &peers);
    // The daemon is gone: so is everything it was carrying.
    std::process::exit(0);
}

/// Private (RFC 1918, ULA, which holds Tailscale's IPv6), link-local, and Tailscale's 100.64/10.
/// Loopback is not: no other program on this Mac reaches the daemon through here.
fn near(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_private() || v4.is_link_local() || (a == 100 && b & 0xc0 == 64)
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => near(v4.into()),
            None => v6.segments()[0] & 0xfe00 == 0xfc00 || v6.segments()[0] & 0xffc0 == 0xfe80,
        },
    }
}

fn send(daemon: &Daemon, stream: u32, kind: u8, bytes: &[u8]) -> io::Result<()> {
    let mut frame = Vec::with_capacity(7 + bytes.len());
    frame.extend(stream.to_be_bytes());
    frame.push(kind);
    frame.extend((bytes.len() as u16).to_be_bytes());
    frame.extend(bytes);
    daemon.lock().unwrap().write_all(&frame)
}

fn accept(listener: TcpListener, daemon: &Daemon, peers: &Peers) {
    for (id, conn) in (1u32..).zip(listener.incoming()) {
        let Ok(conn) = conn else { continue };
        let Ok(addr) = conn.peer_addr() else { continue };
        if !near(addr.ip()) || peers.lock().unwrap().len() >= MAX_STREAMS {
            continue;
        }
        // A peer that stops reading holds up no one else for long.
        // Well under the daemon's 5 s, so one slow phone is dropped before the daemon gives up on us.
        let _ = conn.set_write_timeout(Some(Duration::from_secs(1)));
        let Ok(writer) = conn.try_clone() else {
            continue;
        };
        peers.lock().unwrap().insert(id, writer);
        let (daemon, peers) = (daemon.clone(), peers.clone());
        thread::spawn(move || {
            let _ = send(&daemon, id, OPEN, addr.to_string().as_bytes());
            let _ = from_peer(conn, id, &daemon);
            if peers.lock().unwrap().remove(&id).is_some() {
                let _ = send(&daemon, id, CLOSE, &[]);
            }
        });
    }
}

fn from_peer(mut conn: TcpStream, id: u32, daemon: &Daemon) -> io::Result<()> {
    let mut len = [0; 2];
    // A peer that never says anything doesn't keep its place; the daemon times out the rest.
    conn.set_read_timeout(Some(FIRST))?;
    loop {
        conn.read_exact(&mut len)?;
        let mut bytes = vec![0; u16::from_be_bytes(len) as usize];
        conn.read_exact(&mut bytes)?;
        send(daemon, id, DATA, &bytes)?;
        conn.set_read_timeout(None)?;
    }
}

fn from_daemon(mut daemon: UnixStream, peers: &Peers) -> io::Result<()> {
    let mut head = [0; 7];
    loop {
        daemon.read_exact(&mut head)?;
        let id = u32::from_be_bytes(head[..4].try_into().unwrap());
        let mut bytes = vec![0; u16::from_be_bytes([head[5], head[6]]) as usize];
        daemon.read_exact(&mut bytes)?;
        let mut peers = peers.lock().unwrap();
        match head[4] {
            DATA => {
                let sent = peers.get_mut(&id).map(|conn| {
                    let mut out = (bytes.len() as u16).to_be_bytes().to_vec();
                    out.extend(&bytes);
                    conn.write_all(&out)
                });
                if let Some(Err(_)) = sent
                    && let Some(conn) = peers.remove(&id)
                {
                    let _ = conn.shutdown(Shutdown::Both);
                }
            }
            _ => {
                if let Some(conn) = peers.remove(&id) {
                    let _ = conn.shutdown(Shutdown::Both);
                }
            }
        }
    }
}
