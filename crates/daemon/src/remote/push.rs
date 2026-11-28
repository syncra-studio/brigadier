//! Push (remote design §4 "Push", step 2): a row's new notice goes to each paired phone that sent
//! its `push` row, sealed with HPKE to the phone's notification key `N`, so Apple and the relay
//! see only the fixed "Your Mac needs you". Push has its own switch (`data/remote/push`) and its
//! own socket to the hosted push sender per notification, apart from the relay's: with the relay
//! off, notifications still go (D101 a); with Allow connections off, nothing does.

use super::{State, devices, gateway, relay};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use hpke::aead::ChaCha20Poly1305;
use hpke::kdf::HkdfSha256;
use hpke::kem::X25519HkdfSha256;
use hpke::{Deserializable, Kem, OpModeS, Serializable};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const HOSTED: &str = "wss://relay.brigadier.sh";
/// Proposed: the owner counts as at the Mac after input in this many seconds, and is sent nothing.
const AWAY_S: f64 = 120.0;
/// Titles are cut to this many characters, so a sealed push stays well inside APNs' 4 KB.
const TITLE: usize = 200;

#[derive(Default)]
pub(super) struct Push {
    /// Each row's last notice id; none before the first pass, which only takes them in, so no
    /// notice already there when the daemon starts is sent.
    seen: Option<HashMap<String, String>>,
    /// The push sender's last answer, for `remote status`.
    last: Option<Value>,
}

pub(super) fn on(data: &Path) -> bool {
    data.join("remote/push").exists()
}

/// `remote push on|off`. Off with the relay off too takes the relay key: nothing of it is left.
pub(super) fn set(data: &Path, args: &[String]) -> Value {
    let path = data.join("remote/push");
    let done = match args.get(2).map(String::as_str) {
        Some("on") if args.len() == 3 => brigadier_core::write_atomic(&path, b"on"),
        Some("off") if args.len() == 3 => {
            relay::remove(&path).and_then(|()| match relay::chosen(data) {
                None => relay::remove(&data.join("remote/relay-key")),
                Some(_) => Ok(()),
            })
        }
        _ => return json!({"ok": false, "error": "usage: remote push on|off"}),
    };
    match done {
        Ok(()) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e.to_string()}),
    }
}

pub(super) fn shown(s: &State, data: &Path) -> Value {
    json!({"on": on(data), "last": s.push.last})
}

/// The `push` row: `{id, op, n, token}`, `n` the phone's notification key (X25519, base64) and
/// `token` its APNs device token (hex), kept with the device; a revoke drops them with it.
pub(super) fn register(data: &Path, device: &str, req: &Value) -> Value {
    let n = req["n"].as_str().and_then(|n| B64.decode(n).ok());
    let token = req["token"].as_str().unwrap_or("");
    let fields = req.as_object().is_some_and(|o| o.len() == 4);
    let hex = token.len().is_multiple_of(2) && (64..=200).contains(&token.len());
    let ok = fields
        && n.is_some_and(|n| n.len() == 32)
        && hex
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !ok {
        return json!({"re": req["id"], "ok": false, "error": super::allow::REFUSED});
    }
    let saved = devices::list(data).and_then(|mut all| {
        for d in all.iter_mut().filter(|d| d["id"] == device) {
            d["push"] = json!({"n": req["n"], "token": token});
        }
        devices::save(data, &all)
    });
    match saved {
        Ok(()) => json!({"re": req["id"], "ok": true}),
        Err(e) => json!({"re": req["id"], "ok": false, "error": e.to_string()}),
    }
}

/// Each daemon pass: every row's new notice, sealed for each registered phone, while push and
/// Allow connections are on, the gateway runs and the owner is away from the Mac. A notice held
/// while an automatic switch may carry the work on goes once it isn't, as the desktop's does.
pub(super) fn pass(s: &mut State, data: &Path, rows: &BTreeMap<String, Value>) {
    let mut now: HashMap<String, String> = (rows.iter())
        .filter_map(|(id, r)| Some((id.clone(), r["notice"]["id"].as_str()?.to_string())))
        .collect();
    let Some(seen) = s.push.seen.take() else {
        s.push.seen = Some(now);
        return;
    };
    let (mut new, mut held) = (vec![], vec![]);
    for (id, notice) in &now {
        if seen.get(id) == Some(notice) {
            continue;
        }
        // The row as published, with the switch's hold on it; the index's own lacks it.
        match super::HOST.get().and_then(|h| (h.row)(id)) {
            Some(row) if row["notice"]["held"] == true => held.push(id.clone()),
            row => new.push(row.unwrap_or_else(|| rows[id].clone())),
        }
    }
    // Not taken in yet, so it is news when the hold ends.
    for id in held {
        match seen.get(&id) {
            Some(old) => now.insert(id, old.clone()),
            None => now.remove(&id),
        };
    }
    s.push.seen = Some(now);
    let allowed = data.join("remote/on").exists();
    if new.is_empty() || s.out.is_none() || !allowed || !on(data) || !away() {
        return;
    }
    let (Ok(all), Some(sender)) = (devices::list(data), sender()) else {
        return;
    };
    for row in &new {
        let id = row["id"].as_str().unwrap_or("");
        let kind = match row["notice"]["kind"].as_str() {
            Some("done") => "done",
            Some("failed") => "failed",
            _ => "needs",
        };
        let title: String = row["title"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(TITLE)
            .collect();
        let note = json!({"t": title, "k": kind, "s": id, "n": unix_ms()}).to_string();
        for d in &all {
            let (Some(n), Some(token)) = (d["push"]["n"].as_str(), d["push"]["token"].as_str())
            else {
                continue;
            };
            let Some(sealed) = seal(n, d["id"].as_str().unwrap_or(""), note.as_bytes()) else {
                continue;
            };
            let text = json!({"t": "push", "token": token, "e": B64.encode(sealed)}).to_string();
            match relay::push_url(data, &sender, text.as_bytes()) {
                Ok(url) => gateway::send(s, 0, gateway::PUSH, format!("{url}\n{text}").as_bytes()),
                Err(e) => eprintln!("brigadierd: push: the relay key: {e}"),
            }
        }
    }
}

/// HPKE base mode (RFC 9180) to `N`: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305,
/// CryptoKit's `Curve25519_SHA256_ChachaPoly`, with info `"brigadier/push/v1" ‖ device id (hex)`.
/// The encapsulated key (32 bytes), then the ciphertext.
fn seal(n: &str, device: &str, note: &[u8]) -> Option<Vec<u8>> {
    let key = <X25519HkdfSha256 as Kem>::PublicKey::from_bytes(&B64.decode(n).ok()?).ok()?;
    let info = [b"brigadier/push/v1".as_slice(), device.as_bytes()].concat();
    let (enc, ct) = hpke::single_shot_seal::<ChaCha20Poly1305, HkdfSha256, X25519HkdfSha256>(
        &OpModeS::Base,
        &key,
        &info,
        note,
        b"",
    )
    .ok()?;
    Some([enc.to_bytes().as_slice(), &ct].concat())
}

/// The push sender: always the hosted one, whose Apple key alone reaches the app's phones, so an
/// own relay's users have it too. A test deploy points it elsewhere, as the relay's `hosted`.
fn sender() -> Option<String> {
    let url = std::env::var("BRIGADIER_RELAY_URL").unwrap_or_else(|_| HOSTED.into());
    relay::fits(&url).then_some(url)
}

/// Nothing goes while the owner is at the Mac (design §4). A debug build's demo may say away.
fn away() -> bool {
    let said = relay::dev() && std::env::var_os("BRIGADIER_PUSH_AWAY").is_some_and(|v| v == "1");
    said || brigadier::computer::idle(brigadier::computer::ANY) >= AWAY_S
}

/// The gateway's answer for one push: the sender's `{"t":"pushed","status"}`, or `code` when its
/// socket closed first (0: unreachable).
pub(super) fn answer(s: &mut State, bytes: &[u8]) {
    let Ok(answer) = serde_json::from_slice::<Value>(bytes) else {
        return;
    };
    if answer["status"] != 200 {
        eprintln!("brigadierd: push: {answer}");
    }
    s.push.last = Some(answer);
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}
