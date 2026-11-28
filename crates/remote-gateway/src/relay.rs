//! The relay (remote design §4, step 2): one outbound WebSocket to the URL the daemon names (kind
//! `RELAY` on stream 0; empty ends it), TLS by rustls with Mozilla's roots compiled in, so the
//! sandbox opens only port 443 and the resolver. One URL is one attempt: the daemon signs each
//! and decides when to try again. The relay's text frames go up to the daemon and the daemon's
//! back (kind `CONTROL`), unread: the daemon holds the relay key and signs. Each phone stream the
//! relay opens reaches the daemon as a gateway stream with the top bit set, its address as
//! `relay:<ip>`.

use std::collections::HashSet;
use std::error::Error;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::{Message, WebSocket};

pub const RELAY: u8 = 4;
pub const CONTROL: u8 = 5;
pub const TOP: u32 = 1 << 31;
const PING: Duration = Duration::from_secs(30);
/// How long a read waits before the queue of frames for the relay is looked at again.
const POLL: Duration = Duration::from_millis(20);
const DEADLINE: Duration = Duration::from_secs(10);
/// Frames waiting for a slow relay; past it they're dropped, and a stream missing one fails at
/// Noise, which is the backpressure.
const QUEUE: usize = 1024;

trait Io: Read + Write + Send {}
impl<T: Read + Write + Send> Io for T {}

type Socket = WebSocket<Box<dyn Io>>;

/// What the daemon sends the relay: a stream (0 for a control frame), a kind and its bytes.
type Out = (u32, u8, Vec<u8>);

#[derive(Default)]
pub struct Relay {
    generation: Arc<AtomicU64>,
    to: Mutex<Option<SyncSender<Out>>>,
    /// The current attempt's socket, shut at once when the daemon names another URL or none.
    socket: Arc<Mutex<Option<TcpStream>>>,
}

/// A frame from the daemon for the relay: a new URL, a control frame, or a phone stream's.
pub fn from_daemon(relay: &Relay, id: u32, kind: u8, bytes: Vec<u8>, daemon: &super::Daemon) {
    if id == 0 && kind == RELAY {
        // Under the lock an attempt reports its end under, so a replaced one never reports after.
        let mut slot = relay.socket.lock().unwrap();
        let generation = relay.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(old) = slot.take() {
            let _ = old.shutdown(Shutdown::Both);
        }
        drop(slot);
        let (tx, rx) = mpsc::sync_channel(QUEUE);
        *relay.to.lock().unwrap() = (!bytes.is_empty()).then_some(tx);
        if let Ok(url) = String::from_utf8(bytes)
            && !url.is_empty()
        {
            let (current, socket, daemon) = (
                relay.generation.clone(),
                relay.socket.clone(),
                daemon.clone(),
            );
            thread::spawn(move || run(&url, generation, &current, &socket, &rx, &daemon));
        }
    } else if let Some(to) = &*relay.to.lock().unwrap()
        && to.try_send((id, kind, bytes)).is_err()
    {
        // A relay this far behind is a failed one: ending it makes the daemon connect and send all again.
        if let Some(socket) = &*relay.socket.lock().unwrap() {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
}

/// One attempt and the socket's life. Only the current attempt reports its end: a replaced one's
/// streams are already forgotten by the daemon.
fn run(
    url: &str,
    generation: u64,
    current: &AtomicU64,
    socket: &Mutex<Option<TcpStream>>,
    rx: &Receiver<Out>,
    daemon: &super::Daemon,
) {
    let live = || current.load(Ordering::SeqCst) == generation;
    let mut streams = HashSet::new();
    // The socket is kept before its handshakes, so a new URL or none can shut it mid-way. Checked
    // under the lock the daemon's next URL takes: a replaced attempt never stores its socket.
    let keep = |tcp: TcpStream| {
        let mut slot = socket.lock().unwrap();
        if live() {
            *slot = Some(tcp);
        }
        live()
    };
    let code = match connect(url, &keep) {
        Ok(None) => return,
        Ok(Some(mut ws)) => {
            let code = carry(&mut ws, &live, rx, daemon, &mut streams);
            let _ = ws.close(None);
            let _ = ws.flush();
            code
        }
        Err(e) => {
            eprintln!("brigadier-remote: the relay: {e}");
            0
        }
    };
    // Checked under the lock a new URL takes, but not held while writing to the daemon, which may
    // be waiting on this gateway: the daemon drops a stale `closed` by its `n`, and a stale stream
    // close could only meet a new attempt's stream of the same random 31-bit id.
    let current = {
        let _held = socket.lock().unwrap();
        live()
    };
    if !current {
        return;
    }
    for id in streams {
        let _ = super::send(daemon, TOP | id, super::CLOSE, &[]);
    }
    // `n`: which of the daemon's URLs this was, counting from the first since the gateway started.
    let closed = format!(r#"{{"t":"closed","code":{code},"n":{generation}}}"#);
    let _ = super::send(daemon, 0, CONTROL, closed.as_bytes());
}

/// The socket, or none when `keep` says this attempt was replaced before its handshakes.
fn connect(url: &str, keep: &dyn Fn(TcpStream) -> bool) -> Result<Option<Socket>, Box<dyn Error>> {
    let (tls, rest) = match (url.strip_prefix("wss://"), url.strip_prefix("ws://")) {
        (Some(rest), _) => (true, rest),
        (_, Some(rest)) => (false, rest),
        _ => return Err("not a WebSocket URL".into()),
    };
    let authority = rest.split(['/', '?']).next().unwrap_or("");
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, port.parse()?),
        None => (authority, if tls { 443 } else { 80 }),
    };
    let address = (host, port).to_socket_addrs()?.next().ok_or("no address")?;
    let tcp = TcpStream::connect_timeout(&address, DEADLINE)?;
    tcp.set_nodelay(true)?;
    tcp.set_read_timeout(Some(DEADLINE))?;
    tcp.set_write_timeout(Some(DEADLINE))?;
    let kept = tcp.try_clone()?;
    if !keep(tcp.try_clone()?) {
        return Ok(None);
    }
    let io: Box<dyn Io> = if tls {
        let roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])?
            .with_root_certificates(roots)
            .with_no_client_auth();
        let name = host.to_string().try_into()?;
        let conn = rustls::ClientConnection::new(Arc::new(config), name)?;
        Box::new(rustls::StreamOwned::new(conn, tcp))
    } else {
        Box::new(tcp)
    };
    let mut request = tungstenite::client::IntoClientRequest::into_client_request(url)?;
    // The same for every computer: the relay learns nothing from it.
    request
        .headers_mut()
        .insert("User-Agent", "brigadier".parse()?);
    let (ws, _) = tungstenite::client::client(request, io).map_err(|e| e.to_string())?;
    kept.set_read_timeout(Some(POLL))?;
    Ok(Some(ws))
}

/// The daemon's frames out, the relay's in, until either side ends. Returns the relay's close code.
fn carry(
    ws: &mut Socket,
    live: &dyn Fn() -> bool,
    rx: &Receiver<Out>,
    daemon: &super::Daemon,
    streams: &mut HashSet<u32>,
) -> u16 {
    let mut pinged = Instant::now();
    while live() {
        let mut out = vec![];
        while let Ok((id, kind, bytes)) = rx.try_recv() {
            out.push(match id {
                0 => Message::text(String::from_utf8_lossy(&bytes).into_owned()),
                _ => {
                    let id = id & !TOP;
                    if kind == super::CLOSE && !streams.remove(&id) {
                        continue;
                    }
                    let mut frame = id.to_be_bytes().to_vec();
                    frame.push(kind);
                    frame.extend(bytes);
                    Message::binary(frame)
                }
            });
        }
        if pinged.elapsed() > PING {
            out.push(Message::Ping(Default::default()));
            pinged = Instant::now();
        }
        for message in out {
            if !live() || ws.send(message).is_err() {
                return 0;
            }
        }
        match ws.read() {
            Ok(Message::Text(text)) => {
                let _ = super::send(daemon, 0, CONTROL, text.as_bytes());
            }
            Ok(Message::Binary(frame)) if frame.len() >= 5 => {
                let id = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) & !TOP;
                let (kind, bytes) = (frame[4], &frame[5..]);
                if !phone(ws, daemon, streams, id, kind, bytes) {
                    return 0;
                }
            }
            Ok(Message::Close(frame)) => return frame.map_or(0, |f| f.code.into()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return 0,
        }
    }
    0
}

/// One phone stream's frame from the relay, to the daemon. False when the socket failed.
fn phone(
    ws: &mut Socket,
    daemon: &super::Daemon,
    streams: &mut HashSet<u32>,
    id: u32,
    kind: u8,
    bytes: &[u8],
) -> bool {
    match kind {
        super::OPEN if streams.len() >= super::MAX_STREAMS || id == 0 => {
            let mut frame = id.to_be_bytes().to_vec();
            frame.push(super::CLOSE);
            return ws.send(Message::binary(frame)).is_ok();
        }
        super::OPEN => {
            streams.insert(id);
            let from = format!("relay:{}", String::from_utf8_lossy(bytes));
            let _ = super::send(daemon, TOP | id, super::OPEN, from.as_bytes());
        }
        // A Noise message is at most 65,535 bytes: anything longer isn't one.
        super::DATA if streams.contains(&id) && bytes.len() <= usize::from(u16::MAX) => {
            let _ = super::send(daemon, TOP | id, super::DATA, bytes);
        }
        super::CLOSE if streams.remove(&id) => {
            let _ = super::send(daemon, TOP | id, super::CLOSE, &[]);
        }
        _ => {}
    }
    true
}
