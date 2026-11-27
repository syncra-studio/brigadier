//! Answers that widen what an agent may do, and the powers (remote design §4 "Answers that
//! widen", §4.2, §4.7; D57): each needs a fresh, single-use Face ID signature over the exact
//! command. The phone asks for a `challenge {session, request, action}`; the daemon returns a
//! 32-byte nonce for this stream, good for 60 s and once. The request then carries
//! `act: {nonce, sig}`, `sig` being `Sig_U` over `"brigadier/act/v1" ‖ h ‖ nonce ‖ session ‖
//! request ‖ action ‖ SHA-256(argv)`, each text field a 4-byte big-endian length then its bytes,
//! and `argv` the command's JSON array as sent. The nonce is used up whatever the outcome.

use super::allow::{Ctx, REFUSED};
use super::link::{Stream, key_of};
use super::{devices, powers};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use p256::ecdsa::Signature;
use p256::ecdsa::signature::Verifier;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{Duration, Instant};

pub(super) const NEEDS: &str = "Needs Face ID";
pub(super) const OFF: &str = "Turned off for this iPhone on your Mac";
const LIFE: Duration = Duration::from_secs(60);
/// Proposed: nonces a stream may hold at once; the oldest goes first.
const HELD: usize = 16;

/// What a command's signature must name, decided from the daemon's own record (§4.2).
pub(super) struct Need {
    pub(super) power: Option<&'static str>,
    pub(super) session: String,
    pub(super) request: String,
    pub(super) action: String,
    pub(super) argv: Vec<String>,
}

pub(super) struct Nonce {
    bytes: [u8; 32],
    names: [String; 3],
    at: Instant,
}

type Fail = &'static str;

fn need(power: Option<&'static str>, args: &[String], request: &str, action: &str) -> Need {
    Need {
        power,
        session: args[1].clone(),
        request: request.into(),
        action: action.into(),
        argv: args.to_vec(),
    }
}

/// A command that starts an agent or reaches past the project: the command itself, signed.
pub(super) fn signed(args: &[String]) -> Option<Need> {
    Some(need(None, args, "", &args[0]))
}

/// A power's command: the command itself, signed, and its switch on.
pub(super) fn power(p: &'static str, args: &[String]) -> Option<Need> {
    Some(need(Some(p), args, "", &args[0]))
}

/// `answer`, `level` and `overnight` (§4.1). Returns what a signature must name, if one is needed.
pub(super) fn row(cx: &Ctx, args: &[String]) -> Result<Option<Need>, Fail> {
    let a = |i: usize| args.get(i).map(String::as_str).ok_or(REFUSED);
    let n = args.len();
    let id = a(1)?;
    cx.visible(id)?;
    match a(0)? {
        "level" if n == 5 && matches!(a(2)?, "ask" | "auto" | "full") && a(3)? == "--op" => {
            brigadier_core::check_id(a(4)?).map_err(|_| REFUSED)?;
            Ok(power("level", args))
        }
        "overnight" if n == 5 && matches!(a(2)?, "on" | "start" | "off") && a(3)? == "--op" => {
            brigadier_core::check_id(a(4)?).map_err(|_| REFUSED)?;
            Ok(power("overnight", args))
        }
        "answer" => {
            let request = a(2)?;
            brigadier_core::check_id(request).map_err(|_| REFUSED)?;
            // Brigadier's own questions (a routing hold, a mockup offer) answer by `--answers`
            // and are checked by `answer` against their own record (`control.rs`).
            let own = request.starts_with("hold-") || request.starts_with("mockup-");
            let asked = match own {
                true if a(3)? == "--answers" => Value::Null,
                true => return Err(REFUSED),
                false => pending(cx.data, id, request).ok_or(REFUSED)?,
            };
            let lasting = match (a(3)?, n) {
                ("allowSession", 4) => true,
                // Computer use lasts for the chat; a permission request grants for the turn.
                ("allow", 4) => matches!(asked["action"].as_str(), Some("computer" | "permission")),
                ("deny", 4) => false,
                ("deny", 6) if a(4)? == "--reason" && !a(5)?.starts_with("--") => false,
                ("--answers", 5) => {
                    let given: Vec<Value> = serde_json::from_str(a(4)?).map_err(|_| REFUSED)?;
                    if !given.iter().all(|x| x.is_string() || x.is_null()) {
                        return Err(REFUSED);
                    }
                    false
                }
                _ => return Err(REFUSED),
            };
            Ok(lasting.then(|| need(None, args, request, a(3).unwrap_or(""))))
        }
        _ => Err(REFUSED),
    }
}

/// The ask `request` still waiting in session `id`: what `answer` itself reads
/// (`crates/cli/src/control.rs` `pending`). One it can't find is refused, never taken as one-time.
fn pending(data: &Path, id: &str, request: &str) -> Option<Value> {
    let folded = brigadier_core::fold(&data.join("sessions").join(id), true).ok()?;
    folded.fold.turns.first()?.asks.get(request).cloned()
}

/// `challenge {session, request, action}`: a nonce for this stream.
pub(super) fn challenge(stream: &mut Stream, req: &Value) -> Value {
    let field = |k: &str| req[k].as_str().filter(|v| v.len() <= 256).map(String::from);
    let (Some(session), Some(request), Some(action)) =
        (field("session"), field("request"), field("action"))
    else {
        return json!({"ok": false, "error": REFUSED});
    };
    let mut bytes = [0; 32];
    if getrandom::fill(&mut bytes).is_err() {
        return json!({"ok": false, "error": "no randomness"});
    }
    stream.nonces.retain(|x| x.at.elapsed() < LIFE);
    if stream.nonces.len() >= HELD {
        stream.nonces.remove(0);
    }
    let names = [session, request, action];
    stream.nonces.push(Nonce {
        bytes,
        names,
        at: Instant::now(),
    });
    json!({"ok": true, "nonce": B64.encode(bytes)})
}

fn field(out: &mut Vec<u8>, text: &str) {
    out.extend((text.len() as u32).to_be_bytes());
    out.extend(text.as_bytes());
}

/// Checks `act` against `need` for this stream, using up its nonce first. On success, a power's
/// use goes into the Mac's log.
pub(super) fn verify(
    data: &Path,
    stream: &mut Stream,
    need: &Need,
    act: &Value,
) -> Result<(), Fail> {
    let given = B64
        .decode(act["nonce"].as_str().unwrap_or(""))
        .map_err(|_| NEEDS)?;
    let at = stream
        .nonces
        .iter()
        .position(|x| x.bytes[..] == given[..])
        .ok_or(NEEDS)?;
    let nonce = stream.nonces.remove(at);
    let names = [&need.session, &need.request, &need.action];
    if nonce.at.elapsed() >= LIFE || nonce.names.iter().zip(names).any(|(a, b)| a != b) {
        return Err(NEEDS);
    }
    let device = devices::find(data, &stream.device).ok_or(NEEDS)?;
    if need.power.is_some_and(|p| !powers::on(&device, p)) {
        return Err(OFF);
    }
    let mut msg = b"brigadier/act/v1".to_vec();
    msg.extend(&stream.h);
    msg.extend(nonce.bytes);
    for text in names {
        field(&mut msg, text);
    }
    msg.extend(Sha256::digest(
        serde_json::to_string(&need.argv).map_err(|_| NEEDS)?,
    ));
    let sig = (B64.decode(act["sig"].as_str().unwrap_or("")).ok())
        .and_then(|raw| Signature::from_slice(&raw).ok())
        .ok_or(NEEDS)?;
    key_of(&device)
        .map_err(|_| NEEDS)?
        .verify(&msg, &sig)
        .map_err(|_| NEEDS)?;
    if let Some(p) = need.power {
        powers::log(data, &stream.device, p, &need.argv);
    }
    Ok(())
}
