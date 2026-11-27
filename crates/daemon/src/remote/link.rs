//! Each stream the gateway carries, as remote design §4 runs it. Message 1 of
//! `Noise_IKpsk2_25519_ChaChaPoly_SHA256` names its mode: `qr` mixes in the open offer's secret,
//! `code` its typed code, `device` the psk its pairing left. Message 1 proves nothing and is answered and kept 10 s; the
//! first transport message, the first under keys with the psk, proves it, and then a Face ID
//! signature over the handshake hash (`Sig_U("brigadier/hello/v1" ‖ h)`) pairs a phone (the
//! Mac's Allow follows) or signs one in. After that every message is a JSON frame (4-byte length,
//! split across transport messages), `hello {proto}` first; then each request goes through the
//! allowlist to the op table (`bridge`).

use super::bridge::{self, Bridge};
use super::devices::{self, Session};
use super::pair;
use super::{State, gateway};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::{Value, json};
use snow::TransportState;
use std::collections::HashSet;
use std::time::{Duration, Instant};

pub(super) const PATTERN: &str = "Noise_IKpsk2_25519_ChaChaPoly_SHA256";
const PROLOGUE: &[u8] = b"brigadier/remote/v1";
/// The phone protocol versions this Mac speaks (design §4.5); `app/shared/proto.ts` from S0 on.
const PROTO: (u64, u64) = (1, 1);
/// How long a message 1's handshake waits for the psk's proof, then for the Face ID signature.
const PROVE: Duration = Duration::from_secs(10);
const SIGN: Duration = Duration::from_secs(60);
/// Per source address: handshakes not yet proven at once, and new streams a minute.
const UNPROVEN: usize = 2;
const PER_MINUTE: usize = 10;
/// Proposed: the largest frame a phone may send (an attachment's base64, from M4).
const MAX_IN: usize = 16 << 20;
const CHUNK: usize = 65535 - 16;

#[derive(PartialEq)]
pub(super) enum Step {
    New,
    Proving,
    Signing,
    /// Waiting for the Mac's Allow.
    Pairing,
    Device {
        hello: bool,
    },
}

pub(super) struct Stream {
    source: String,
    pub(super) step: Step,
    since: Instant,
    t: Option<TransportState>,
    pub(super) h: Vec<u8>,
    pub(super) rs: Vec<u8>,
    /// Message 1's payload: its mode, and when pairing the phone's name, model, OS and `u`.
    pub(super) info: Value,
    /// The device signed in, or the offer this pairing used.
    pub(super) device: String,
    offer: u64,
    buf: Vec<u8>,
    /// The way to the op table once `hello` fits, and the `@` menu requests it is answering.
    pub(super) bridge: Option<Bridge>,
    pub(super) mentions: HashSet<String>,
    /// Challenges issued on this stream, not yet used.
    pub(super) nonces: Vec<super::fresh::Nonce>,
}

impl Stream {
    pub(super) fn bridge_n(&self) -> Option<u64> {
        self.bridge.as_ref().map(|b| b.n)
    }
}

/// A frame from the gateway.
pub(super) fn frame(s: &mut State, id: u32, kind: u8, bytes: &[u8]) {
    match kind {
        gateway::OPEN => open(s, id, &String::from_utf8_lossy(bytes)),
        gateway::DATA => {
            if let Err(why) = data(s, id, bytes) {
                eprintln!("brigadierd: phone stream {id}: {why}");
                close(s, id);
            }
        }
        _ => forget(s, id),
    }
}

fn open(s: &mut State, id: u32, peer: &str) {
    let source = peer.rsplit_once(':').map_or(peer, |(ip, _)| ip).to_string();
    let opens = s.opens.entry(source.clone()).or_default();
    opens.retain(|at| at.elapsed() < Duration::from_secs(60));
    let unproven = (s.streams.values())
        .filter(|st| st.source == source && matches!(st.step, Step::New | Step::Proving))
        .count();
    if opens.len() >= PER_MINUTE || unproven >= UNPROVEN {
        return gateway::send(s, id, gateway::CLOSE, &[]);
    }
    opens.push(Instant::now());
    let stream = Stream {
        source,
        step: Step::New,
        since: Instant::now(),
        t: None,
        h: vec![],
        rs: vec![],
        info: Value::Null,
        device: String::new(),
        offer: 0,
        buf: vec![],
        bridge: None,
        mentions: HashSet::new(),
        nonces: vec![],
    };
    s.streams.insert(id, stream);
}

type Fail = Box<dyn std::error::Error>;

fn data(s: &mut State, id: u32, bytes: &[u8]) -> Result<(), Fail> {
    let Some(stream) = s.streams.get_mut(&id) else {
        return Ok(());
    };
    if stream.step == Step::New {
        return first(s, id, bytes);
    }
    let t = stream.t.as_mut().ok_or("no channel")?;
    let mut plain = vec![0; bytes.len()];
    let n = t.read_message(bytes, &mut plain)?;
    stream.buf.extend_from_slice(&plain[..n]);
    if stream.step == Step::Proving {
        (stream.step, stream.since) = (Step::Signing, Instant::now());
    }
    let mut frames = vec![];
    while stream.buf.len() >= 4 {
        let len = u32::from_be_bytes(stream.buf[..4].try_into()?) as usize;
        if len > MAX_IN {
            return Err("frame too large".into());
        }
        if stream.buf.len() < 4 + len {
            break;
        }
        frames.push(serde_json::from_slice::<Value>(&stream.buf[4..4 + len])?);
        stream.buf.drain(..4 + len);
    }
    for frame in frames {
        if s.streams.contains_key(&id) {
            request(s, id, &frame)?;
        }
    }
    Ok(())
}

/// Message 1: answered with message 2 under the psk its mode names, or the stream is closed.
fn first(s: &mut State, id: u32, bytes: &[u8]) -> Result<(), Fail> {
    let mut hs = snow::Builder::new(PATTERN.parse()?)
        .local_private_key(&s.key)?
        .prologue(PROLOGUE)?
        .build_responder()?;
    let mut payload = vec![0; bytes.len()];
    let n = hs.read_message(bytes, &mut payload)?;
    let info: Value = serde_json::from_slice(&payload[..n])?;
    let rs = hs.get_remote_static().ok_or("no static key")?.to_vec();
    let (psk, device, offer) = match info["mode"].as_str() {
        Some(kind @ ("qr" | "code")) => {
            let offer = s
                .offer
                .as_ref()
                .filter(|o| o.live())
                .ok_or("no open offer")?;
            key_of(&info)?;
            let secret = if kind == "qr" {
                &offer.secret[..]
            } else {
                offer.code.as_bytes()
            };
            (pair::psk(secret, kind), String::new(), offer.n)
        }
        Some("device") => {
            let device = devices::id_of(&rs);
            let known = devices::find(&s.data, &device).ok_or("not a device of this Mac")?;
            (B64.decode(known["psk"].as_str().unwrap_or(""))?, device, 0)
        }
        _ => return Err("unknown mode".into()),
    };
    hs.set_psk(2, &psk)?;
    let mut out = vec![0; 256];
    let n = hs.write_message(br#"{"v":1}"#, &mut out)?;
    let h = hs.get_handshake_hash().to_vec();
    let t = hs.into_transport_mode()?;
    gateway::send(s, id, gateway::DATA, &out[..n]);
    let stream = s.streams.get_mut(&id).ok_or("gone")?;
    (stream.step, stream.since, stream.t) = (Step::Proving, Instant::now(), Some(t));
    (stream.h, stream.rs, stream.info) = (h, rs, info);
    (stream.device, stream.offer) = (device, offer);
    Ok(())
}

pub(super) fn key_of(info: &Value) -> Result<VerifyingKey, Fail> {
    Ok(VerifyingKey::from_sec1_bytes(
        &B64.decode(info["u"].as_str().ok_or("no u")?)?,
    )?)
}

fn signed(u: &VerifyingKey, h: &[u8], sig: &Value) -> bool {
    let msg = [b"brigadier/hello/v1".as_slice(), h].concat();
    (B64.decode(sig.as_str().unwrap_or("")).ok())
        .and_then(|raw| Signature::from_slice(&raw).ok())
        .is_some_and(|sig| u.verify(&msg, &sig).is_ok())
}

fn request(s: &mut State, id: u32, req: &Value) -> Result<(), Fail> {
    let stream = s.streams.get_mut(&id).ok_or("gone")?;
    match stream.step {
        Step::Signing if stream.info["mode"] != "device" => {
            if !signed(&key_of(&stream.info)?, &stream.h, &req["sig"]) {
                return Err("bad signature".into());
            }
            let offer = stream.offer;
            pair::completed(s, id, offer);
        }
        Step::Signing => {
            let device = stream.device.clone();
            let known = devices::find(&s.data, &device).ok_or("revoked")?;
            let live = s.sessions.get(&device).is_some_and(Session::live);
            let fresh = signed(&key_of(&known)?, &stream.h, &req["sig"]);
            if !fresh && !(req["resume"] == true && live) {
                return reply(s, id, &json!({"signed": false, "error": "Needs Face ID"}));
            }
            if fresh || !live {
                let now = Instant::now();
                let session = Session {
                    since: now,
                    last: now,
                };
                s.sessions.insert(device.clone(), session);
            }
            signed_in(s, id, &device);
        }
        Step::Device { hello } => {
            let device = stream.device.clone();
            let re = req["id"].clone();
            let Some(session) = s.sessions.get_mut(&device).filter(|x| x.live()) else {
                reply(
                    s,
                    id,
                    &json!({"re": re, "ok": false, "error": "Needs Face ID"}),
                )?;
                return Err("session over".into());
            };
            session.last = Instant::now();
            let answer = match req["op"].as_str() {
                Some("hello") => {
                    let proto = req["proto"].as_u64().unwrap_or(0);
                    let fits = (PROTO.0..=PROTO.1).contains(&proto);
                    if let Some(st) = s.streams.get_mut(&id) {
                        st.step = Step::Device { hello: fits };
                        if fits && st.bridge.is_none() {
                            st.bridge = Some(bridge::open(id, &device)?);
                        }
                    }
                    json!({"ok": fits, "error": (!fits).then_some("proto"), "proto_min": PROTO.0,
                        "proto_max": PROTO.1, "build": brigadier_frames::wire::build(), "name": s.live.as_ref().map(|l| &l.1)})
                }
                _ if !hello => json!({"ok": false, "error": "proto"}),
                _ => return Ok(bridge::request(s, id, &device, req)?),
            };
            let mut answer = answer;
            answer["re"] = re;
            reply(s, id, &answer)?;
        }
        // Waiting for Allow: the phone has nothing to say yet.
        _ => {}
    }
    Ok(())
}

/// A stream now carrying `device`'s signed-in session.
pub(super) fn signed_in(s: &mut State, id: u32, device: &str) {
    if let Some(stream) = s.streams.get_mut(&id) {
        (stream.step, stream.device) = (Step::Device { hello: false }, device.into());
    }
    pair::seen(s, device);
    let name = s.live.as_ref().map(|l| l.1.clone());
    let _ = reply(
        s,
        id,
        &json!({"signed": true, "device": device, "name": name}),
    );
}

/// One JSON frame to the phone, split into transport messages.
pub(super) fn reply(s: &mut State, id: u32, frame: &Value) -> Result<(), Fail> {
    let body = frame.to_string();
    let mut plain = (body.len() as u32).to_be_bytes().to_vec();
    plain.extend_from_slice(body.as_bytes());
    let mut sealed = vec![];
    let t = (s.streams.get_mut(&id).and_then(|st| st.t.as_mut())).ok_or("no channel")?;
    for chunk in plain.chunks(CHUNK) {
        let mut out = vec![0; chunk.len() + 16];
        let n = t.write_message(chunk, &mut out)?;
        out.truncate(n);
        sealed.push(out);
    }
    for out in sealed {
        gateway::send(s, id, gateway::DATA, &out);
    }
    Ok(())
}

/// Ends a stream from this side.
pub(super) fn close(s: &mut State, id: u32) {
    gateway::send(s, id, gateway::CLOSE, &[]);
    forget(s, id);
}

/// A stream gone: a pairing waiting on it ends with it.
fn forget(s: &mut State, id: u32) {
    if s.streams.remove(&id).is_some() && s.pending.as_ref().is_some_and(|p| p.stream == id) {
        (s.pending, s.offer) = (None, None);
    }
}

/// What has waited too long ends: handshakes, a pairing's Allow, offers and device sessions.
pub(super) fn tick(s: &mut State) {
    s.sessions.retain(|_, session| session.live());
    s.opens.retain(|_, opens| {
        opens.retain(|at| at.elapsed() < Duration::from_secs(60));
        !opens.is_empty()
    });
    let over: Vec<u32> = (s.streams.iter())
        .filter(|(_, st)| match &st.step {
            Step::New | Step::Proving => st.since.elapsed() > PROVE,
            Step::Signing => st.since.elapsed() > SIGN,
            Step::Device { .. } => !s.sessions.contains_key(&st.device),
            Step::Pairing => false,
        })
        .map(|(id, _)| *id)
        .collect();
    for id in over {
        close(s, id);
    }
    pair::tick(s);
}
