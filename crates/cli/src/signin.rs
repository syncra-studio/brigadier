//! Brigadier's one sign-in per remote MCP server [wave4 D2030, D2043]: `plugins signin|wait|cancel|
//! signout <key>`. Only the daemon holds grants: in memory, saved in the library's one Keychain
//! item, and it alone refreshes them, one refresh at a time per server, ahead of expiry, the new
//! token saved before it is used. Only a refusal (`invalid_grant`) marks a server Needs sign-in;
//! an outage keeps the grant and tries again. Nothing is ever deleted on a failure.

mod flow;
pub(crate) use flow::PRESET_PORT;
mod oauth;

pub use oauth::check;

use brigadier_core::library::{self, secrets};
use oauth::{Client, Failed};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{fs, io, thread};

/// A browser sign-in left this long ends.
const WAIT: Duration = Duration::from_secs(10 * 60);
/// A failed refresh waits this long, doubling to `BACKOFF_MAX`, before the next try.
const BACKOFF: u64 = 15;
const BACKOFF_MAX: u64 = 600;

#[derive(Clone, Serialize, Deserialize)]
struct Grant {
    access: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh: Option<String>,
    /// Unix seconds; 0 when the server gave no lifetime.
    expires: u64,
    issued: u64,
    client: Client,
    token_endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    revoke: Option<String>,
    resource: String,
    /// The server refused it (`invalid_grant`): kept, but only a new sign-in helps.
    #[serde(default)]
    rejected: bool,
}

/// What the daemon knows of one server's sign-in besides its grant.
#[derive(Default)]
struct Live {
    /// The browser or device sign-in under way, its cancel flag.
    signing: Option<Arc<AtomicBool>>,
    /// The last sign-in's outcome, for `wait`: Ok, or its error line.
    ended: Option<Result<(), String>>,
    /// Unix seconds before which no refresh is tried, and the current backoff.
    retry: (u64, u64),
    /// The last refresh couldn't reach the server.
    unreachable: bool,
    /// A refresh runs, so the daemon's pass starts no other.
    busy: bool,
}

#[derive(Default)]
struct State {
    loaded: bool,
    grants: HashMap<String, Grant>,
    live: HashMap<String, Live>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
static ENDED: Condvar = Condvar::new();
/// One lock per server: one refresh at a time, and a waiter adopts what the first one got.
static REFRESH: Mutex<Option<HashMap<String, Arc<Mutex<()>>>>> = Mutex::new(None);

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// The state, the grants read from the Keychain item the first time.
fn state<T>(data: &Path, f: impl FnOnce(&mut State) -> T) -> T {
    let mut s = STATE.lock().unwrap();
    let s = s.get_or_insert_with(State::default);
    // A Keychain that can't be read yet (locked) is tried again on the next call.
    if !s.loaded
        && let Ok(all) = secrets::read(data)
    {
        s.loaded = true;
        {
            for (key, v) in all {
                if let Ok(g) = serde_json::from_value::<Grant>(v["oauth"].clone()) {
                    s.grants.insert(key, g);
                }
            }
        }
    }
    f(s)
}

/// Saves (or, with None, removes) a server's grant in the Keychain item, read back whole.
fn save(data: &Path, key: &str, grant: Option<&Grant>) -> io::Result<()> {
    secrets::update(data, |all| {
        let entry = all.entry(key.to_string()).or_insert_with(|| json!({}));
        match grant {
            Some(g) => entry["oauth"] = serde_json::to_value(g).unwrap_or_default(),
            None => {
                entry.as_object_mut().map(|o| o.remove("oauth"));
            }
        }
    })
}

fn item(data: &Path, key: &str) -> Option<Value> {
    library::items(data).into_iter().find(|i| i["key"] == key)
}

/// The key of the library remote server session `session` was given as `name`.
fn served(data: &Path, session: &str, name: &str) -> Option<String> {
    let project = brigadier_core::load(data, session).ok()?.project;
    let mine = |i: &Value| {
        i["kind"] == "server"
            && i["url"].is_string()
            && library::named(i["name"].as_str().unwrap_or("")) == name
            && library::on(i, project.as_deref())
    };
    let found = library::items(data).into_iter().find(mine)?;
    found["key"].as_str().map(String::from)
}

fn refuse(message: &str) -> Value {
    json!({"ok": false, "error": message})
}

/// The library's remote server `key`: its URL and plain name.
fn server(data: &Path, key: &str) -> Result<(String, String), Value> {
    let item = item(data, key).ok_or_else(|| refuse("No such plugin."))?;
    match item["url"].as_str() {
        Some(url) => Ok((url.into(), item["name"].as_str().unwrap_or(key).into())),
        None => Err(refuse("Only a remote server signs in.")),
    }
}

/// `plugins signin|wait|cancel|signout <key>`.
pub fn run(data: &Path, words: &[&str]) -> Value {
    match words {
        ["signin", key] => flow::signin(data, key),
        ["wait", key] => flow::wait(data, key),
        ["cancel", key] => {
            if let Some(c) = state(data, |s| s.live.get(*key).and_then(|l| l.signing.clone())) {
                c.store(true, Ordering::SeqCst);
            }
            json!({"ok": true})
        }
        ["signout", key] => signout(data, key),
        _ => refuse("Use `plugins signin|wait|cancel|signout <key>`."),
    }
}

/// What `plugins` shows for a remote server: signed_in, needs_sign_in or cant_reach.
pub fn status(data: &Path, key: &str) -> &'static str {
    state(data, |s| match s.grants.get(key) {
        Some(g) if !g.rejected => match s.live.get(key).is_some_and(|l| l.unreachable) {
            true => "cant_reach",
            false => "signed_in",
        },
        _ => "needs_sign_in",
    })
}

/// Whether Brigadier holds a grant for it the server hasn't refused, signed in even if unreachable.
pub fn signed_in(data: &Path, key: &str) -> bool {
    state(data, |s| s.grants.get(key).is_some_and(|g| !g.rejected))
}

/// Whether the server at `url` takes Brigadier's sign-in: "brigadier", "cli" when it signs in
/// only each agent [wave4 D2045], None when it needs none. Asked once, when it is added; `client`
/// when it comes with a pre-registered client id [D578].
pub fn kind(url: &str, client: bool) -> Result<Option<&'static str>, String> {
    let Some(found) = oauth::discover(url)? else {
        return Ok(None);
    };
    Ok(Some(if client || oauth::registers(&found) {
        "brigadier"
    } else {
        "cli"
    }))
}

/// Signs out: revokes at the server where it offers that, then removes only this server's grant
/// (the Keychain item goes with its last secret).
fn signout(data: &Path, key: &str) -> Value {
    // Out of memory first, so a refresh or sign-in finishing meanwhile can't bring it back.
    let g = state(data, |s| {
        let live = s.live.remove(key).unwrap_or_default();
        live.signing.inspect(|c| c.store(true, Ordering::SeqCst));
        s.grants.remove(key)
    });
    if let Some(g) = &g
        && let Some(at) = &g.revoke
    {
        let (token, hint) = g
            .refresh
            .as_ref()
            .map_or((&g.access, "access_token"), |r| (r, "refresh_token"));
        let mut pairs = vec![
            ("token", token.as_str()),
            ("token_type_hint", hint),
            ("client_id", g.client.id.as_str()),
        ];
        if let Some(s) = &g.client.secret {
            pairs.push(("client_secret", s));
        }
        let _ = oauth::fetch(
            "POST",
            at,
            Some("application/x-www-form-urlencoded"),
            &oauth::form(&pairs),
        );
    }
    if let Err(e) = save(data, key, None) {
        if let Some(g) = g {
            state(data, |s| {
                s.grants.entry(key.into()).or_insert(g);
            });
        }
        return refuse(&format!(
            "Brigadier couldn't remove the sign-in from the Keychain: {e}"
        ));
    }
    json!({"ok": true})
}

/// Why no token can be had.
pub enum Need {
    SignIn,
    Unreachable,
}

/// The server's current access token. `stale`, the token an upstream just refused: unless a newer
/// one is already held, the daemon refreshes once; waiters on that refresh adopt its token.
pub fn token(data: &Path, key: &str, stale: Option<&str>) -> Result<String, Need> {
    let held = state(data, |s| s.grants.get(key).cloned()).ok_or(Need::SignIn)?;
    if held.rejected {
        return Err(Need::SignIn);
    }
    let resting = state(data, |s| s.live.get(key).is_some_and(|l| l.retry.0 > now()));
    if stale.is_none_or(|t| t != held.access) && (!due(&held) || resting) {
        return Ok(held.access);
    }
    let lock = {
        let mut all = REFRESH.lock().unwrap();
        all.get_or_insert_with(HashMap::new)
            .entry(key.into())
            .or_default()
            .clone()
    };
    let _one = lock.lock().unwrap();
    let g = state(data, |s| s.grants.get(key).cloned()).ok_or(Need::SignIn)?;
    // Another refresh ran while this one waited: take its token.
    if g.access != held.access || g.rejected {
        return if g.rejected {
            Err(Need::SignIn)
        } else {
            Ok(g.access)
        };
    }
    let expired = g.expires != 0 && g.expires <= now();
    // Resting after an outage: no request until its retry is due.
    if state(data, |s| s.live.get(key).is_some_and(|l| l.retry.0 > now())) {
        return match stale.is_none() && !expired {
            true => Ok(g.access),
            false => Err(Need::Unreachable),
        };
    }
    let Some(refresh) = g.refresh.clone() else {
        // Nothing to refresh with: a refused token needs a sign-in; an unrefused one is still used.
        return match stale.is_some() || expired {
            true => {
                reject(data, key, &g);
                Err(Need::SignIn)
            }
            false => Ok(g.access),
        };
    };
    let pairs = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh.as_str()),
    ];
    match oauth::token(&g.token_endpoint, &g.client, &g.resource, &pairs) {
        Ok(v) => {
            let mut new = g.clone();
            new.access = v["access_token"].as_str().unwrap_or("").into();
            // A server that rotates sends a new refresh token; one that doesn't keeps the old.
            if let Some(r) = v["refresh_token"].as_str() {
                new.refresh = Some(r.into());
            }
            (new.issued, new.expires) = (now(), v["expires_in"].as_u64().map_or(0, |s| now() + s));
            // Saved before use, and only while its grant stands: a sign-out or a new sign-in
            // meanwhile wins. A failed save still holds the rotated token in memory: the old one
            // is spent, and the next refresh saves again.
            state(data, |s| match s.grants.get(key) {
                None => Err(Need::SignIn),
                Some(now) if now.access != g.access => Ok(now.access.clone()),
                Some(_) => {
                    let _ = save(data, key, Some(&new));
                    s.grants.insert(key.into(), new.clone());
                    let live = s.live.entry(key.into()).or_default();
                    (live.unreachable, live.retry) = (false, (0, 0));
                    Ok(new.access)
                }
            })
        }
        Err(Failed::Rejected) => {
            reject(data, key, &g);
            Err(Need::SignIn)
        }
        Err(_) => {
            state(data, |s| {
                let live = s.live.entry(key.into()).or_default();
                let wait = (live.retry.1 * 2).clamp(BACKOFF, BACKOFF_MAX);
                (live.unreachable, live.retry) = (true, (now() + wait, wait));
            });
            match stale.is_none() && !expired {
                true => Ok(g.access),
                false => Err(Need::Unreachable),
            }
        }
    }
}

/// Marks a grant refused: kept, shown as Needs sign-in.
fn reject(data: &Path, key: &str, g: &Grant) {
    let mut g = g.clone();
    g.rejected = true;
    state(data, |s| {
        if s.grants.get(key).is_some_and(|now| now.access == g.access) {
            let _ = save(data, key, Some(&g));
            s.grants.insert(key.into(), g);
        }
    });
}

/// Due for a refresh: within a minute or a tenth of its lifetime of expiring, but never in its
/// first half, so a short-lived token isn't refreshed on every pass.
fn due(g: &Grant) -> bool {
    let life = g.expires.saturating_sub(g.issued);
    let early = (life / 10).max(60).min(life / 2);
    g.expires != 0 && g.refresh.is_some() && g.expires.saturating_sub(early) <= now()
}

/// The daemon's pass: refreshes each grant coming due, in the background, one at a time each.
pub fn pass(data: &Path) {
    let due: Vec<String> = state(data, |s| {
        let keys: Vec<String> = (s.grants.iter())
            .filter(|(k, g)| {
                !g.rejected
                    && due(g)
                    && s.live.get(*k).is_none_or(|l| !l.busy && l.retry.0 <= now())
            })
            .map(|(k, _)| k.clone())
            .collect();
        for k in &keys {
            s.live.entry(k.clone()).or_default().busy = true;
        }
        keys
    });
    for key in due {
        let data = data.to_path_buf();
        thread::spawn(move || {
            let _ = token(&data, &key, None);
            state(&data, |s| s.live.entry(key).or_default().busy = false);
        });
    }
}

/// What a library remote server is reached with right now, for the relay and a session's proxy:
/// its URL, its headers (an API key, or the sign-in's fresh token) and its plain name.
pub fn reach(
    data: &Path,
    key: &str,
    stale: Option<&str>,
) -> Result<(String, Map<String, Value>, String), String> {
    let (url, title) =
        server(data, key).map_err(|e| e["error"].as_str().unwrap_or("").to_string())?;
    let mut headers: Map<String, Value> = secrets::read(data)
        .ok()
        .and_then(|s| s.get(key)?["headers"].as_object().cloned())
        .unwrap_or_default();
    let signs_in = item(data, key).is_some_and(|i| i["sign_in"] == "brigadier")
        || state(data, |s| s.grants.contains_key(key));
    if signs_in {
        match token(
            data,
            key,
            stale.map(|s| s.strip_prefix("Bearer ").unwrap_or(s)),
        ) {
            Ok(t) => headers.insert("Authorization".into(), format!("Bearer {t}").into()),
            Err(Need::SignIn) => {
                return Err(format!(
                    "{title} needs sign-in in Brigadier (Settings › Plugins)."
                ));
            }
            Err(Need::Unreachable) => {
                return Err(format!(
                    "{title} can't be reached right now. Brigadier keeps trying."
                ));
            }
        };
    }
    Ok((url, headers, title))
}

/// The daemon's `upstream` op: answered only to the session's own host (`peer` is the caller's
/// pid), never to its agent, so no agent command ever prints a token.
pub fn upstream(data: &Path, peer: i32, req: &Value) -> Value {
    let session = req["session"].as_str().unwrap_or("");
    if brigadier_core::check_id(session).is_err() {
        return refuse("No such session.");
    }
    let owner: Value = fs::read(brigadier_core::session_dir(data, session).join("owner.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let start = brigadier_frames::procs::info(peer).map(|p| p.start_us);
    if owner["pid"] != peer || start.is_none() || owner["start_us"] != start.unwrap_or(0) {
        return refuse("Only this session's host may ask.");
    }
    let Some(key) = served(data, session, req["server"].as_str().unwrap_or("")) else {
        return refuse("This session has no such server.");
    };
    match reach(data, &key, req["stale"].as_str()) {
        Ok((url, headers, title)) => {
            json!({"ok": true, "url": url, "headers": headers, "title": title})
        }
        Err(e) => refuse(&e),
    }
}
