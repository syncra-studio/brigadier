//! Pairing offers and the Mac's Allow (remote design §4 "Pairing, exactly"), and the `remote`
//! commands Settings › Connections runs. An offer holds a one-time secret for 5 minutes. A
//! message 1 never uses it up; it is used up only when a phone proves the secret and signs the
//! handshake with its Face ID key. Then the Mac shows the 6-digit check code both screens derive
//! from the handshake hash and waits 2 minutes for Allow. A second phone completing the same offer
//! cancels it and warns: someone else holds the code.

use super::devices::{self, Session};
use super::link::{self, Step};
use super::{STATE, State};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as URL};
use hkdf::Hkdf;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const LIFE: Duration = Duration::from_secs(5 * 60);
const ALLOW: Duration = Duration::from_secs(2 * 60);
/// A second ask this soon gets the same offer: a page drawing again never churns codes.
const AGAIN: Duration = Duration::from_secs(10);

pub(super) struct Offer {
    pub(super) n: u64,
    pub(super) secret: [u8; 32],
    /// The typed code: 16 Crockford base32 characters (80 bits), its psk taken from their ASCII.
    pub(super) code: String,
    made: Instant,
    expires: u64,
    used: bool,
}

impl Offer {
    pub(super) fn open(&self) -> bool {
        !self.used && self.live()
    }

    /// Kept until it expires, used or not, so a second phone holding it is caught.
    pub(super) fn live(&self) -> bool {
        self.made.elapsed() < LIFE
    }
}

pub(super) struct Pending {
    pub(super) stream: u32,
    check: String,
    at: Instant,
}

/// The psk a secret gives for one kind of pairing: `qr` or `code`.
pub(super) fn psk(secret: &[u8], kind: &str) -> Vec<u8> {
    let mut out = [0; 32];
    let info = format!("brigadier/pair/{kind}/v1");
    let _ = Hkdf::<Sha256>::new(None, secret).expand(info.as_bytes(), &mut out);
    out.to_vec()
}

/// The 6 digits both screens show, from the handshake hash.
fn check_of(h: &[u8]) -> String {
    let d = Sha256::digest([b"brigadier/check/v1".as_slice(), h].concat());
    format!(
        "{:06}",
        u32::from_be_bytes([d[0], d[1], d[2], d[3]]) % 1_000_000
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The phone proved the offer's secret and signed: the first time, the Mac asks; the second, the
/// offer is cancelled, with its first phone, and the Mac warns.
pub(super) fn completed(s: &mut State, id: u32, offer: u64) {
    let Some(open) = s.offer.as_mut().filter(|o| o.n == offer) else {
        return link::close(s, id);
    };
    if open.used || !open.live() {
        if let Some(first) = s.pending.take() {
            link::close(s, first.stream);
        }
        (s.offer, s.warning) = (None, Some("reused"));
        return link::close(s, id);
    }
    open.used = true;
    let Some(stream) = s.streams.get_mut(&id) else {
        return;
    };
    stream.step = Step::Pairing;
    let check = check_of(&stream.h);
    s.pending = Some(Pending {
        stream: id,
        check,
        at: Instant::now(),
    });
}

/// The Mac's answer to the waiting phone: Allow stores it and signs it in at once.
fn answer(s: &mut State, allow: bool) -> Value {
    let Some(pending) = s.pending.take() else {
        return json!({"ok": false, "error": "No device is waiting."});
    };
    let id = pending.stream;
    let Some((rs, h, info)) =
        (s.streams.get(&id)).map(|st| (st.rs.clone(), st.h.clone(), st.info.clone()))
    else {
        return json!({"ok": false, "error": "That device is gone."});
    };
    if !allow {
        // Someone holding the code was turned away: the next QR is a fresh one.
        s.offer = None;
        let _ = link::reply(s, id, &json!({"paired": false}));
        link::close(s, id);
        return json!({"ok": true});
    }
    let device = devices::id_of(&rs);
    let mut out = [0; 32];
    let _ = Hkdf::<Sha256>::new(None, &h).expand(b"brigadier/device/v1", &mut out);
    let record = json!({"id": device, "name": info["name"], "model": info["model"], "os": info["os"],
        "u": info["u"], "psk": B64.encode(out), "paired": now_ms(), "seen": now_ms()});
    let saved = devices::list(&s.data).and_then(|mut all| {
        all.retain(|d| d["id"] != device);
        all.push(record);
        devices::save(&s.data, &all)
    });
    if let Err(e) = saved {
        link::close(s, id);
        return json!({"ok": false, "error": e.to_string()});
    }
    let now = Instant::now();
    s.sessions.insert(
        device.clone(),
        Session {
            since: now,
            last: now,
        },
    );
    let _ = link::reply(s, id, &json!({"paired": true}));
    link::signed_in(s, id, &device);
    json!({"ok": true, "device": device})
}

/// A device's last-connected time, saved at each sign-in.
pub(super) fn seen(s: &mut State, device: &str) {
    let Ok(mut all) = devices::list(&s.data) else {
        return;
    };
    if let Some(d) = all.iter_mut().find(|d| d["id"] == device) {
        d["seen"] = now_ms().into();
        let _ = devices::save(&s.data, &all);
    }
}

pub(super) fn tick(s: &mut State) {
    if s.pending.as_ref().is_some_and(|p| p.at.elapsed() > ALLOW) {
        answer(s, false);
    }
    if s.offer.as_ref().is_some_and(|o| !o.live()) {
        s.offer = None;
    }
}

/// Where the phone finds this Mac: each private, link-local or Tailscale IPv4 address it has.
fn addresses(port: u16) -> Vec<String> {
    let mut found = vec![];
    let mut list = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut list) } != 0 {
        return found;
    }
    let mut at = list;
    while let Some(ifa) = unsafe { at.as_ref() } {
        let addr = unsafe { ifa.ifa_addr.as_ref() };
        if addr.is_some_and(|a| a.sa_family as i32 == libc::AF_INET) {
            let v4 = unsafe { &*(ifa.ifa_addr as *const libc::sockaddr_in) };
            let ip = std::net::Ipv4Addr::from(u32::from_be(v4.sin_addr.s_addr));
            let [a, b, ..] = ip.octets();
            if ip.is_private() || ip.is_link_local() || (a == 100 && b & 0xc0 == 64) {
                found.push(format!("{ip}:{port}"));
            }
        }
        at = ifa.ifa_next;
    }
    unsafe { libc::freeifaddrs(list) };
    found
}

/// 10 bytes as 16 Crockford base32 characters, 5 bits each.
fn crockford(bytes: &[u8; 10]) -> String {
    const ABC: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let n = bytes.iter().fold(0u128, |n, b| n << 8 | u128::from(*b));
    (0..16)
        .rev()
        .map(|i| ABC[(n >> (5 * i)) as usize & 31] as char)
        .collect()
}

fn shown(s: &State, offer: &Offer) -> Value {
    let port = s.live.as_ref().map_or(0, |l| l.0);
    let url = format!(
        "https://brigadier.sh/p#v=1&m={}&s={}&a={}&e={}",
        URL.encode(s.public),
        URL.encode(offer.secret),
        addresses(port).join(","),
        offer.expires / 1000
    );
    let svg = qrcode::QrCode::new(&url).map_or(String::new(), |qr| {
        qr.render::<qrcode::render::svg::Color>()
            .min_dimensions(240, 240)
            .build()
    });
    json!({"url": url, "code": offer.code, "svg": svg, "expires": offer.expires})
}

fn offer(s: &mut State, data: &Path) -> Value {
    if s.live.is_none() {
        let error = match data.join("remote/on").exists() {
            true => "Starting. Try again in a moment.",
            false => "Allow connections is off",
        };
        return json!({"ok": false, "error": error});
    }
    s.warning = None;
    if s.pending.is_none()
        && !s
            .offer
            .as_ref()
            .is_some_and(|o| o.open() && o.made.elapsed() < AGAIN)
    {
        let (mut secret, mut code) = ([0; 32], [0; 10]);
        if let Err(e) = getrandom::fill(&mut secret).and_then(|()| getrandom::fill(&mut code)) {
            return json!({"ok": false, "error": e.to_string()});
        }
        s.made += 1;
        s.offer = Some(Offer {
            n: s.made,
            secret,
            code: crockford(&code),
            made: Instant::now(),
            expires: now_ms() + LIFE.as_millis() as u64,
            used: false,
        });
    }
    match &s.offer {
        Some(offer) => json!({"ok": true, "offer": shown(s, offer)}),
        None => json!({"ok": false, "error": "A device is waiting for Allow."}),
    }
}

fn status(s: &State, data: &Path) -> Value {
    let seen = |id: &Value| {
        (s.sessions.get(id.as_str().unwrap_or("")))
            .map(|x| now_ms() - x.last.elapsed().as_millis() as u64)
    };
    let devices: Vec<Value> = match devices::list(data) {
        Ok(all) => all
            .iter()
            .map(|d| devices::shown(d, seen(&d["id"])))
            .collect(),
        Err(e) => return json!({"ok": false, "error": e.to_string()}),
    };
    let pending = s.pending.as_ref().and_then(|p| {
        let info = &s.streams.get(&p.stream)?.info;
        Some(json!({"device": info["name"], "check": p.check}))
    });
    let (port, name) = s
        .live
        .clone()
        .map_or((None, None), |(p, n)| (Some(p), Some(n)));
    json!({"ok": true, "on": data.join("remote/on").exists(), "port": port,
        "name": name.unwrap_or_else(super::name),
        "offer": s.offer.as_ref().filter(|o| o.open()).map(|o| shown(s, o)),
        "pending": pending, "warning": s.warning, "devices": devices, "awake": null})
}

/// Keys, slots, sessions and streams: all of a device, at once.
fn revoke(s: &mut State, data: &Path, device: &str) -> Value {
    let mut all = match devices::list(data) {
        Ok(all) => all,
        Err(e) => return json!({"ok": false, "error": e.to_string()}),
    };
    let before = all.len();
    all.retain(|d| d["id"] != device);
    if all.len() == before {
        return json!({"ok": false, "error": "No such device."});
    }
    if let Err(e) = devices::save(data, &all) {
        return json!({"ok": false, "error": e.to_string()});
    }
    s.sessions.remove(device);
    let streams: Vec<u32> = (s.streams.iter())
        .filter(|(_, st)| st.device == device)
        .map(|(id, _)| *id)
        .collect();
    for id in streams {
        link::close(s, id);
    }
    json!({"ok": true})
}

/// `remote status | on | off | offer | allow | deny | revoke <device>`.
pub(super) fn cli(data: &Path, args: &[String]) -> Value {
    let mut s = STATE.lock().unwrap();
    let done = |r: std::io::Result<()>| match r {
        Ok(()) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e.to_string()}),
    };
    match (args.get(1).map(String::as_str), args.get(2)) {
        (Some("status"), None) => status(&s, data),
        (Some("on"), None) => done(
            fs::create_dir_all(data.join("remote"))
                .and_then(|()| brigadier_core::write_atomic(&data.join("remote/on"), b"on")),
        ),
        (Some("off"), None) => done(match fs::remove_file(data.join("remote/on")) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }),
        (Some("offer"), None) => offer(&mut s, data),
        (Some("allow"), None) => answer(&mut s, true),
        (Some("deny"), None) => answer(&mut s, false),
        (Some("revoke"), Some(device)) => revoke(&mut s, data, device),
        (Some("device"), Some(id)) if args.len() == 6 && args[3] == "power" => {
            super::powers::set(data, id, &args[4], &args[5])
        }
        (Some("log"), Some(device)) if args.len() == 3 => super::powers::entries(data, device),
        _ => {
            json!({"ok": false, "error": "usage: remote status|on|off|offer|allow|deny|revoke <device>|device <id> power <p> on|off|log <device>"})
        }
    }
}
