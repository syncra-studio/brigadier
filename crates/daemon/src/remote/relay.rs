//! The relay, step 2 (remote design §4): while `data/remote/relay` names one (`hosted` or
//! `own <url>`), the gateway keeps a socket to it and the daemon does the talking. The relay asks
//! the computer to prove its room with a P-256 key of its own (`remote/relay-key`; the Noise key
//! is X25519, which can't sign); then the daemon keeps the relay's lists equal to its own: the
//! hashes of each paired phone's relay token, and while an offer is open its QR and code invites
//! and the code's lookup. The relay only ever holds hashes and the computer's public keys.

use super::{State, devices, gateway, link};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as URL};
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const HOSTED: &str = "wss://relay.brigadier.sh";
/// A phone's pass from `hello` lasts this long, renewed at every sign-in.
const PASS_LIFE: u64 = 90 * 24 * 3600;
const MAX_WAIT: Duration = Duration::from_secs(60);

#[derive(Default)]
pub(super) struct Relay {
    /// The relay chosen and named to the gateway, if any.
    told: Option<String>,
    key: Option<SigningKey>,
    ready: bool,
    /// A signed URL is with the gateway and it hasn't said `closed`; else the next try waits
    /// until `retry`, `wait` doubling from 1 s to a minute.
    trying: bool,
    retry: Option<Instant>,
    wait: Duration,
    /// Just `ready`: the relay's lists are sent whole, whatever was sent before.
    fresh: bool,
    /// URLs (and empties) named to the gateway since it started; its `closed` says which it ends.
    named: u64,
    /// When the room last had a computer, from the relay's `ready`, and its last close code: none
    /// since this relay was chosen, so a first try reads apart from "can't reach" (0).
    seen: u64,
    closed: Option<u64>,
    /// The relay's last `usage` frame for this room: this month's bytes, its ceiling, and whether
    /// phones are paused. Kept across reconnects; a new relay choice drops it.
    usage: Option<Value>,
    /// Kept across reconnects, so a removal made while away still goes out.
    sent: Lists,
}

#[derive(Default, PartialEq, Clone)]
struct Lists {
    tokens: Vec<String>,
    /// `(hash or lookup id, until)`; a lookup also carries the Mac's Noise key.
    invites: Vec<(String, u64)>,
    lookups: Vec<(String, u64)>,
    /// Invites (false) and lookups (true) taken off, kept until they'd have ended anyway and sent
    /// again after each `ready`: one sent as a socket failed may never have arrived.
    removed: Vec<(bool, String, u64)>,
}

/// Debug builds only, and only when asked: a relay on this computer's own loopback.
pub(super) fn dev() -> bool {
    cfg!(debug_assertions) && std::env::var_os("BRIGADIER_RELAY_DEV").is_some_and(|v| v == "1")
}

fn fits(url: &str) -> bool {
    let plain = url.strip_prefix("ws://");
    let ok = url.starts_with("wss://")
        || (dev() && plain.is_some_and(|rest| rest.starts_with("127.0.0.1:")));
    // It rides in the QR's fragment: nothing that would end a field there.
    ok && !url.contains(['&', '#', ' '])
}

/// The relay chosen, if any and usable. `hosted` may be pointed elsewhere for a test deploy.
pub(super) fn chosen(data: &Path) -> Option<String> {
    let text = fs::read_to_string(data.join("remote/relay")).ok()?;
    let url = match text.trim().split_once(' ') {
        None if text.trim() == "hosted" => {
            std::env::var("BRIGADIER_RELAY_URL").unwrap_or_else(|_| HOSTED.into())
        }
        Some(("own", url)) => url.into(),
        _ => return None,
    };
    fits(&url).then_some(url)
}

/// `remote relay off | hosted | own <url>`.
pub(super) fn set(data: &Path, args: &[String]) -> Value {
    let path = data.join("remote/relay");
    let written = match (args.get(2).map(String::as_str), args.get(3)) {
        // The key goes too: while the relay is off, nothing of it is left.
        (Some("off"), None) => remove(&path).and_then(|()| remove(&data.join("remote/relay-key"))),
        (Some("hosted"), None) => brigadier_core::write_atomic(&path, b"hosted"),
        (Some("own"), Some(url)) if args.len() == 4 && fits(&wss(url)) => {
            brigadier_core::write_atomic(&path, format!("own {}", wss(url)).as_bytes())
        }
        (Some("own"), Some(_)) => {
            return json!({"ok": false, "error": "That isn't a wss:// address."});
        }
        _ => return json!({"ok": false, "error": "usage: remote relay off|hosted|own <wss url>"}),
    };
    match written {
        Ok(()) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e.to_string()}),
    }
}

fn remove(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Cloudflare shows a deployed relay's address as `https://`; the computer reaches it as `wss://`.
fn wss(url: &str) -> String {
    let url = url.trim();
    url.strip_prefix("https://")
        .map_or(url.into(), |rest| format!("wss://{rest}"))
}

/// The relay key, made the first time a relay is chosen; never while none is.
fn key(data: &Path) -> std::io::Result<SigningKey> {
    let path = data.join("remote/relay-key");
    match fs::read(&path) {
        Ok(bytes) => SigningKey::from_slice(&bytes)
            .map_err(|_| std::io::Error::other("data/remote/relay-key is damaged")),
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        Err(_) => loop {
            let mut bytes = [0; 32];
            getrandom::fill(&mut bytes).map_err(std::io::Error::other)?;
            // Almost every 32 bytes is a key; the rest are drawn again.
            if let Ok(key) = SigningKey::from_slice(&bytes) {
                devices::write_private(&path, &bytes)?;
                return Ok(key);
            }
        },
    }
}

fn public(key: &SigningKey) -> Vec<u8> {
    key.verifying_key().to_sec1_point(false).as_bytes().to_vec()
}

fn room(key: &SigningKey) -> [u8; 32] {
    Sha256::digest(public(key)).into()
}

fn derive(ikm: &[u8], info: &str) -> [u8; 32] {
    let mut out = [0; 32];
    let _ = Hkdf::<Sha256>::new(None, ikm).expand(info.as_bytes(), &mut out);
    out
}

fn hash(bytes: &[u8]) -> String {
    devices::hex(&Sha256::digest(bytes))
}

/// Each daemon pass, with the gateway running: the gateway told of the relay chosen, and the
/// relay's lists brought level with this computer's.
pub(super) fn pass(s: &mut State, data: &Path) {
    let want = chosen(data);
    if want.is_none() {
        s.relay.key = None;
    }
    if want != s.relay.told {
        // The old relay's phone streams end with it.
        let gone: Vec<u32> = (s.streams.keys().copied())
            .filter(|id| id & gateway::TOP != 0)
            .collect();
        for id in gone {
            link::close(s, id);
        }
        if want.is_none() {
            name(s, "");
        }
        let r = &mut s.relay;
        (r.told, r.ready, r.trying, r.retry, r.closed) = (want, false, false, None, None);
        r.usage = None;
        r.wait = Duration::from_secs(1);
    }
    let due = s.relay.retry.is_none_or(|t| Instant::now() >= t);
    if let Some(url) = s.relay.told.clone()
        && !s.relay.trying
        && !s.relay.ready
        && due
    {
        if s.relay.key.is_none() {
            match key(data) {
                Ok(key) => s.relay.key = Some(key),
                Err(e) => {
                    s.relay.retry = Some(Instant::now() + MAX_WAIT);
                    return eprintln!("brigadierd: the relay key: {e}");
                }
            }
        }
        let key = s.relay.key.as_ref().expect("loaded above");
        let at = unix();
        let sig = sign(key, b"brigadier/relay/open/v1", at);
        let socket = format!(
            "{}/v1/mac?key={}&at={at}&sig={sig}",
            url.trim_end_matches('/'),
            URL.encode(public(key))
        );
        name(s, &socket);
        s.relay.trying = true;
    }
    if !s.relay.ready {
        return;
    }
    let Ok(all) = devices::list(data) else { return };
    let mut tokens: Vec<String> = (all.iter())
        .filter_map(|d| B64.decode(d["psk"].as_str()?).ok())
        .map(|psk| hash(&derive(&psk, "brigadier/relay/device/v1")))
        .collect();
    tokens.sort();
    let mut want = Lists {
        tokens,
        ..Lists::default()
    };
    if let Some(offer) = s.offer.as_ref().filter(|o| o.live()) {
        let until = offer.expires / 1000;
        let code = offer.code.as_bytes();
        want.invites = vec![
            (
                hash(&derive(&offer.secret, "brigadier/relay/invite/v1")),
                until,
            ),
            (hash(&derive(code, "brigadier/relay/invite/code/v1")), until),
        ];
        want.lookups = vec![(
            devices::hex(&derive(code, "brigadier/relay/lookup/v1")),
            until,
        )];
    }
    let sent = std::mem::take(&mut s.relay.sent);
    let fresh = std::mem::take(&mut s.relay.fresh);
    if fresh || want.tokens != sent.tokens {
        control(s, &json!({"t": "tokens", "set": want.tokens}));
    }
    let now = unix();
    let mut removed: Vec<_> = (sent.removed.into_iter()).filter(|r| r.2 > now).collect();
    if fresh {
        removed
            .iter()
            .for_each(|(lookup, id, _)| take_off(s, *lookup, id));
    }
    for (lookup, list, kept) in [
        (false, &sent.invites, &want.invites),
        (true, &sent.lookups, &want.lookups),
    ] {
        for (id, until) in list.iter().filter(|i| !kept.contains(i)) {
            take_off(s, lookup, id);
            removed.push((lookup, id.clone(), *until));
        }
    }
    want.removed = removed;
    for (h, until) in (want.invites.iter()).filter(|i| fresh || !sent.invites.contains(i)) {
        control(s, &json!({"t": "invite", "h": h, "until": until}));
    }
    for (id, until) in (want.lookups.iter()).filter(|i| fresh || !sent.lookups.contains(i)) {
        let mut frame = ticket(s, *until).unwrap_or_default();
        frame["t"] = "lookup".into();
        frame["id"] = id.as_str().into();
        frame["m"] = URL.encode(s.public).into();
        control(s, &frame);
    }
    s.relay.sent = want;
}

fn take_off(s: &State, lookup: bool, id: &str) {
    control(
        s,
        &match lookup {
            true => json!({"t": "lookup", "id": id, "until": 0}),
            false => json!({"t": "invite", "h": id, "until": 0}),
        },
    );
}

fn name(s: &mut State, url: &str) {
    gateway::send(s, 0, gateway::RELAY, url.as_bytes());
    s.relay.named += 1;
}

fn control(s: &State, frame: &Value) {
    gateway::send(s, 0, gateway::CONTROL, frame.to_string().as_bytes());
}

/// A text frame from the relay (or the gateway's own `closed`).
pub(super) fn from_relay(s: &mut State, bytes: &[u8]) {
    let Ok(frame) = serde_json::from_slice::<Value>(bytes) else {
        return;
    };
    match frame["t"].as_str() {
        Some("challenge") => {
            let (Some(key), Ok(nonce)) = (
                &s.relay.key,
                B64.decode(frame["nonce"].as_str().unwrap_or("")),
            ) else {
                return;
            };
            let signed = [b"brigadier/relay/mac/v1".as_slice(), &room(key), &nonce].concat();
            let sig: Signature = key.sign(&signed);
            let proof = json!({"t": "proof", "key": B64.encode(public(key)), "sig": B64.encode(sig.to_bytes())});
            control(s, &proof);
        }
        Some("ready") => {
            let r = &mut s.relay;
            (r.ready, r.fresh, r.wait) = (true, true, Duration::from_secs(1));
            r.seen = frame["seen"].as_u64().unwrap_or(0);
        }
        Some("usage") => s.relay.usage = Some(frame),
        // A replaced attempt's end, crossing the newer URL on its way: not this one's.
        Some("closed") if frame["n"].as_u64() != Some(s.relay.named) => {}
        Some("closed") => {
            let r = &mut s.relay;
            (r.ready, r.trying, r.retry) = (false, false, Some(Instant::now() + r.wait));
            r.wait = (r.wait * 2).min(MAX_WAIT);
            r.closed = Some(frame["code"].as_u64().unwrap_or(0));
        }
        _ => {}
    }
}

fn unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// b64url r‖s over `label ‖ room ‖ time (8 bytes, big-endian)`: the relay's front door checks it
/// before waking any room.
fn sign(key: &SigningKey, label: &[u8], time: u64) -> String {
    let sig: Signature = key.sign(&[label, &room(key), &time.to_be_bytes()].concat());
    URL.encode(sig.to_bytes())
}

/// While the relay carries this computer: a pass to its room until then, for the QR, `hello` and
/// the code's lookup (`{url, room, key, until, sig}`).
pub(super) fn ticket(s: &State, until: u64) -> Option<Value> {
    let key = s.relay.key.as_ref().filter(|_| s.relay.ready)?;
    Some(
        json!({"url": s.relay.told.as_ref()?, "room": devices::hex(&room(key)),
        "key": URL.encode(public(key)), "until": until,
        "sig": sign(key, b"brigadier/relay/pass/v1", until)}),
    )
}

/// `hello`'s pass.
pub(super) fn hello(s: &State) -> Option<Value> {
    ticket(s, unix() + PASS_LIFE)
}

/// The gateway went: whatever it was told goes with it, but not what the relay still holds.
pub(super) fn reset(s: &mut State) {
    let sent = std::mem::take(&mut s.relay.sent);
    let usage = s.relay.usage.take();
    s.relay = Relay {
        sent,
        usage,
        ..Relay::default()
    };
}

/// For `remote status`.
pub(super) fn shown(s: &State, data: &Path) -> Value {
    let mode = fs::read_to_string(data.join("remote/relay")).ok();
    let mode = mode
        .as_deref()
        .map(str::trim)
        .and_then(|m| m.split(' ').next())
        .unwrap_or("off");
    let room = s.relay.key.as_ref().map(|k| devices::hex(&room(k)));
    json!({"mode": mode, "url": s.relay.told, "ready": s.relay.ready, "room": room,
        "seen": s.relay.seen, "closed": s.relay.closed, "usage": s.relay.usage})
}
