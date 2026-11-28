//! A signed-in phone's way to the daemon's own op table. Each stream that passed `hello` gets a
//! socket pair: one end is served by `ops::serve` as `Caller::Remote`, the other is written only
//! with [`allow::Checked`] requests and pumped back to the phone through Noise. Both guards are
//! types: [`Device`], the only way to get a `Caller::Remote`, is built only here, and the writer
//! takes only what the allowlist built. So no request reaches the op table as the phone's without
//! the table [beat-competitors D51, the Delegator's condition on M3a].

use super::allow::{self, Checked};
use super::fresh;
use super::{HOST, STATE, link};
use brigadier_frames::wire;
use serde_json::Value;
use std::io::{self, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

/// Bridges made since the daemon started: each one's connection number and its stream's mark.
static MADE: AtomicU64 = AtomicU64::new(0);

/// The device a `Caller::Remote` serves. Its field is private, so only this file makes one.
pub(crate) struct Device {
    #[expect(
        dead_code,
        reason = "the op table reads it from M3b on (the powers' log)"
    )]
    id: String,
}

pub(super) struct Bridge {
    to: UnixStream,
    pub(super) n: u64,
}

impl Drop for Bridge {
    /// Ends both threads: `ops::serve` reads the end of its stream, the pump its last frame.
    fn drop(&mut self) {
        let _ = self.to.shutdown(Shutdown::Both);
    }
}

impl Bridge {
    pub(super) fn send(&mut self, req: Checked) -> io::Result<()> {
        wire::write_frame(&mut self.to, &req.value().to_string())
    }
}

/// The bridge for stream `id`, signed in as `device`.
pub(super) fn open(id: u32, device: &str) -> io::Result<Bridge> {
    let host = HOST.get().ok_or_else(|| io::Error::other("no host"))?;
    let (mut ours, theirs) = UnixStream::pair()?;
    ours.set_write_timeout(Some(Duration::from_secs(5)))?;
    ours.write_all(&wire::DAEMON_PROTOCOL.to_be_bytes())?;
    let n = MADE.fetch_add(1, Ordering::SeqCst) + 1;
    let device = Device { id: device.into() };
    // Above the socket's own connection numbers, which count up from 0.
    let conn = 1 << 63 | n;
    thread::spawn(move || (host.serve)(theirs, conn, device));
    let from = ours.try_clone()?;
    thread::spawn(move || pump(from, id, n));
    Ok(Bridge { to: ours, n })
}

/// The op table's frames to the phone, until either side ends. Its greeting is the daemon's own
/// and stays here: the phone had `hello`.
fn pump(mut from: UnixStream, id: u32, n: u64) {
    let _ = wire::read_frame(&mut from);
    while let Ok(text) = wire::read_frame(&mut from) {
        let Ok(mut frame) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let mut s = STATE.lock().unwrap();
        let Some(stream) = s.streams.get_mut(&id).filter(|st| st.bridge_n() == Some(n)) else {
            return;
        };
        if stream.mentions.remove(&frame["re"].to_string()) {
            no_paths(&mut frame);
        }
        if link::reply(&mut s, id, &frame).is_err() {
            return;
        }
    }
}

/// An `@` menu reply without its file and folder results: Mac paths (§4.1, power (e)).
fn no_paths(frame: &mut Value) {
    match frame {
        Value::Array(items) => {
            items.retain(|i| !matches!(i["type"].as_str(), Some("file" | "folder")));
            items.iter_mut().for_each(no_paths);
        }
        Value::Object(map) => map.values_mut().for_each(no_paths),
        _ => {}
    }
}

/// A phone's request after `hello`: through the table and on, or refused here.
/// Proposed: `attachment` pieces (256 KB each) a stream may take per minute, about 60 MB.
const PIECES: (usize, std::time::Duration) = (240, std::time::Duration::from_secs(60));

pub(super) fn request(
    s: &mut super::State,
    id: u32,
    device: &str,
    req: &Value,
) -> Result<(), String> {
    let host = HOST.get().ok_or("no host")?;
    let data = s.data.clone();
    if req["op"] == "challenge" {
        let stream = s.streams.get_mut(&id).ok_or("gone")?;
        let mut answer = fresh::challenge(stream, req);
        answer["re"] = req["id"].clone();
        return link::reply(s, id, &answer).map_err(|e| e.to_string());
    }
    let cx = allow::Ctx {
        device,
        host,
        data: &data,
        resolved: Default::default(),
    };
    if req["op"] == "push" {
        let answer = super::push::register(&data, device, req);
        return link::reply(s, id, &answer).map_err(|e| e.to_string());
    }
    if req["op"] == "attachment" {
        let stream = s.streams.get_mut(&id).ok_or("gone")?;
        stream.pieces.retain(|at| at.elapsed() < PIECES.1);
        if stream.pieces.len() >= PIECES.0 {
            let busy = serde_json::json!({"re": req["id"], "ok": false, "error": "busy"});
            return link::reply(s, id, &busy).map_err(|e| e.to_string());
        }
        stream.pieces.push(std::time::Instant::now());
        let mut answer = super::files::attachment(&cx, req);
        // Each file once in the device's Activity, at its first piece.
        if answer["ok"] == true && req["offset"].as_u64().unwrap_or(0) == 0 {
            let names = [
                req["owner"].as_str().unwrap_or(""),
                req["attachment"].as_str().unwrap_or(""),
            ];
            super::powers::log(&data, device, "attachment", &names.map(String::from));
        }
        answer["re"] = req["id"].as_u64().into();
        return link::reply(s, id, &answer).map_err(|e| e.to_string());
    }
    let checked = match allow::check(&cx, req) {
        Ok(checked) => checked,
        Err(why) => {
            let mut refused = serde_json::json!({"re": req["id"], "ok": false, "error": why});
            if why == super::rows::NOT_CANONICAL {
                refused["path"] = cx.resolved.take().into();
            }
            return link::reply(s, id, &refused).map_err(|e| e.to_string());
        }
    };
    let stream = s.streams.get_mut(&id).ok_or("gone")?;
    // An id still awaiting an `@` menu answer would take its redaction marker.
    if stream.mentions.contains(&checked.value()["id"].to_string()) {
        let refused = serde_json::json!({"re": req["id"], "ok": false, "error": allow::REFUSED});
        return link::reply(s, id, &refused).map_err(|e| e.to_string());
    }
    if checked.value()["op"] == "mention" {
        stream.mentions.insert(checked.value()["id"].to_string());
    }
    // Checked against its fresh signature, if it needs one; nothing reaches the agent otherwise.
    if let Some(need) = checked.need()
        && let Err(why) = fresh::verify(&data, stream, need, &req["act"])
    {
        let refused = serde_json::json!({"re": req["id"], "ok": false, "error": why});
        return link::reply(s, id, &refused).map_err(|e| e.to_string());
    }
    let bridge = stream.bridge.as_mut().ok_or("no bridge")?;
    bridge.send(checked).map_err(|e| e.to_string())
}
