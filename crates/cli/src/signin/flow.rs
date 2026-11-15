//! A sign-in's flow: the browser's, back to a loopback redirect on 127.0.0.1, or the device flow
//! (RFC 8628) for a pre-registered client without a secret.

use super::oauth::{self, Client, Failed, Found, check};
use super::{ENDED, Grant, STATE, State, WAIT, now, refuse, save, server, state};
use brigadier_core::library;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use std::{fs, thread};

/// Starts a sign-in and answers its URL at once (and the code a device sign-in asks for); the
/// daemon finishes it when the browser comes back. A sign-in already under way is replaced.
pub(super) fn signin(data: &Path, key: &str) -> Value {
    let (url, _) = match server(data, key) {
        Ok(s) => s,
        Err(e) => return e,
    };
    let found = match oauth::discover(&url) {
        Ok(Some(f)) => f,
        Ok(None) => return refuse("This server needs no sign-in."),
        Err(e) => return refuse(&e),
    };
    let cancel = Arc::new(AtomicBool::new(false));
    state(data, |s| {
        let live = s.live.entry(key.into()).or_default();
        if let Some(old) = live.signing.replace(cancel.clone()) {
            old.store(true, Ordering::SeqCst);
        }
        live.ended = None;
    });
    start(data, key, found, cancel.clone()).unwrap_or_else(|e| {
        end(data, key, &cancel, Err(e.clone()));
        refuse(&e)
    })
}

/// The registrations kept per issuer, in `library/clients.json`: public clients only, no secret.
fn kept<T>(data: &Path, f: impl FnOnce(&mut HashMap<String, Client>) -> T) -> T {
    let path = data.join("library").join("clients.json");
    let mut kept: HashMap<String, Client> = fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let before = kept.len();
    let out = f(&mut kept);
    if kept.len() != before {
        let _ = fs::create_dir_all(path.parent().unwrap());
        let _ = brigadier_core::write_atomic(
            &path,
            &serde_json::to_vec_pretty(&kept).unwrap_or_default(),
        );
    }
    out
}

/// The client to sign in as, and the loopback listener its redirect comes back to.
fn client(data: &Path, key: &str, found: &Found) -> Result<(Client, Option<TcpListener>), String> {
    // Kept per issuer, but a redirect names its port, so a kept one goes only while that port is free.
    if let Some(c) = kept(data, |k| k.get(&found.issuer).cloned()) {
        let port = c
            .redirect
            .strip_prefix("http://127.0.0.1:")
            .and_then(|r| r.split('/').next()?.parse::<u16>().ok());
        if let Some(Ok(l)) = port.map(|p| TcpListener::bind(("127.0.0.1", p))) {
            return Ok((c, Some(l)));
        }
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| "Brigadier can't listen for the sign-in.")?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let Some(mut c) = oauth::register(found, &redirect)? else {
        // Refused: from now on each agent signs in to it itself [wave4 D2045].
        let mut items = library::items(data);
        for i in items.iter_mut().filter(|i| i["key"] == key) {
            i["sign_in"] = "cli".into();
        }
        let _ = library::save(data, &items);
        return Err("This server signs in only each agent itself.".into());
    };
    if c.redirect.is_empty() && !c.device {
        c.redirect = redirect;
    }
    if c.secret.is_none() && !c.device {
        kept(data, |k| k.insert(found.issuer.clone(), c.clone()));
    }
    Ok((c.clone(), (!c.device).then_some(listener)))
}

fn start(data: &Path, key: &str, found: Found, cancel: Arc<AtomicBool>) -> Result<Value, String> {
    let (client, listener) = client(data, key, &found)?;
    let endpoint = found.meta["token_endpoint"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let base = Grant {
        access: String::new(),
        refresh: None,
        expires: 0,
        issued: 0,
        client: client.clone(),
        token_endpoint: endpoint.clone(),
        revoke: found.meta["revocation_endpoint"].as_str().map(String::from),
        resource: found.resource.clone(),
        rejected: false,
    };
    let grant = move |v: &Value| Grant {
        access: v["access_token"].as_str().unwrap_or("").into(),
        refresh: v["refresh_token"].as_str().map(String::from),
        expires: v["expires_in"].as_u64().map_or(0, |s| now() + s),
        issued: now(),
        ..base.clone()
    };
    let (data, key) = (data.to_path_buf(), key.to_string());
    let Some(listener) = listener else {
        // The device flow (RFC 8628): the user types the code at the server's page.
        let at = found.meta["device_authorization_endpoint"]
            .as_str()
            .ok_or("No device sign-in.")?;
        let body = oauth::form(&[("client_id", &client.id), ("scope", &found.scope)]);
        let r = oauth::fetch("POST", at, Some("application/x-www-form-urlencoded"), &body)
            .map_err(|_| "Brigadier can't reach this server's sign-in.")?;
        let v = r.json();
        let (Some(code), Some(page)) = (v["device_code"].as_str(), v["verification_uri"].as_str())
        else {
            return Err("This server's sign-in gave no code.".into());
        };
        check(page)?;
        let (code, mut every) = (code.to_string(), v["interval"].as_u64().unwrap_or(5));
        let reply = json!({"ok": true, "url": page, "code": v["user_code"]});
        thread::spawn(move || {
            let until = Instant::now() + WAIT;
            let outcome = loop {
                thread::sleep(Duration::from_secs(every));
                if cancel.load(Ordering::SeqCst) || Instant::now() > until {
                    break Err("Sign-in was cancelled.".to_string());
                }
                let pairs = [
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                    ("device_code", code.as_str()),
                ];
                match oauth::token(&endpoint, &client, "", &pairs) {
                    Ok(v) => break keep(&data, &key, &cancel, grant(&v)),
                    Err(Failed::Pending(slow)) => every += if slow { 5 } else { 0 },
                    Err(Failed::Rejected) => break Err("The sign-in was declined.".into()),
                    Err(Failed::Unreachable) => {}
                }
            };
            end(&data, &key, &cancel, outcome);
        });
        return Ok(reply);
    };
    let (verifier, sent) = (oauth::random(), oauth::random());
    let at = found.meta["authorization_endpoint"]
        .as_str()
        .ok_or("This server's sign-in has no page.")?;
    let query = oauth::form(&[
        ("response_type", "code"),
        ("client_id", &client.id),
        ("redirect_uri", &client.redirect),
        ("code_challenge", &oauth::challenge(&verifier)),
        ("code_challenge_method", "S256"),
        ("state", &sent),
        ("resource", &found.resource),
        ("scope", &found.scope),
    ]);
    let url = format!("{at}{}{query}", if at.contains('?') { "&" } else { "?" });
    check(&url)?;
    let (issuer, iss_sent) = (
        found.issuer.clone(),
        found.meta["authorization_response_iss_parameter_supported"] == true,
    );
    thread::spawn(move || {
        let outcome = callback(&listener, &cancel, &sent, &issuer, iss_sent).and_then(|code| {
            let pairs = [
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", &client.redirect),
                ("code_verifier", &verifier),
            ];
            match oauth::token(&endpoint, &client, &found.resource, &pairs) {
                Ok(v) => keep(&data, &key, &cancel, grant(&v)),
                Err(Failed::Rejected) => Err("The server refused the sign-in.".into()),
                Err(_) => Err("Brigadier can't reach this server's sign-in.".into()),
            }
        });
        // A server may forget a registration: one that didn't finish a sign-in is made anew next time.
        if outcome.is_err() {
            kept(&data, |k| k.remove(&issuer));
        }
        end(&data, &key, &cancel, outcome);
    });
    Ok(json!({"ok": true, "url": url}))
}

/// Waits on the loopback listener for the browser's redirect: its code, once `state` and `iss`
/// (RFC 9207) are the ones sent.
fn callback(
    listener: &TcpListener,
    cancel: &AtomicBool,
    sent: &str,
    issuer: &str,
    iss_sent: bool,
) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let until = Instant::now() + WAIT;
    loop {
        if cancel.load(Ordering::SeqCst) || Instant::now() > until {
            return Err("Sign-in was cancelled.".into());
        }
        let Ok((mut stream, _)) = listener.accept() else {
            thread::sleep(Duration::from_millis(200));
            continue;
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let mut line = String::new();
        let _ = BufReader::new(&stream).read_line(&mut line);
        let target = line.split_whitespace().nth(1).unwrap_or("");
        let Some(q) = target.strip_prefix("/callback?") else {
            let _ = stream.write_all(
                b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            );
            continue;
        };
        let iss = oauth::query(q, "iss");
        let outcome = if oauth::query(q, "state").as_deref() != Some(sent) {
            Err("The sign-in came back for another request.".to_string())
        } else if iss.as_deref().map_or(iss_sent, |i| {
            i.trim_end_matches('/') != issuer.trim_end_matches('/')
        }) {
            Err("The sign-in came back from another server.".into())
        } else {
            oauth::query(q, "code")
                .filter(|c| !c.is_empty())
                .ok_or_else(|| "The sign-in was declined.".into())
        };
        let page = match &outcome {
            Ok(_) => "Signed in. You can close this tab and return to Brigadier.",
            Err(e) => e.as_str(),
        };
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{page}",
            page.len()
        );
        // A stray request with another state is answered and waited past; only ours ends it.
        if outcome
            .as_ref()
            .is_err_and(|e| e.starts_with("The sign-in came back for another"))
        {
            continue;
        }
        return outcome;
    }
}

/// Saves a new grant, then holds it.
/// Keeps a finished sign-in's grant, unless it was cancelled, replaced or signed out meanwhile.
fn keep(data: &Path, key: &str, cancel: &AtomicBool, g: Grant) -> Result<(), String> {
    state(data, |s| {
        if cancel.load(Ordering::SeqCst) {
            return Err("Sign-in cancelled.".to_string());
        }
        save(data, key, Some(&g))
            .map_err(|_| "Brigadier couldn't save the sign-in in the Keychain.".to_string())?;
        s.grants.insert(key.into(), g);
        let live = s.live.entry(key.into()).or_default();
        (live.unreachable, live.retry) = (false, (0, 0));
        Ok(())
    })
}

fn end(data: &Path, key: &str, cancel: &Arc<AtomicBool>, outcome: Result<(), String>) {
    state(data, |s| {
        let live = s.live.entry(key.into()).or_default();
        // A sign-in replaced by a newer one says nothing.
        if live
            .signing
            .as_ref()
            .is_some_and(|c| Arc::ptr_eq(c, cancel))
        {
            live.signing = None;
            live.ended = Some(outcome);
        }
    });
    ENDED.notify_all();
}

/// Waits for the sign-in under way to end: Ok, or its error line.
pub(super) fn wait(data: &Path, key: &str) -> Value {
    state(data, |_| ());
    let mut s = STATE.lock().unwrap();
    loop {
        let live = s.as_mut().and_then(|s| s.live.get_mut(key));
        match live {
            Some(l) if l.signing.is_some() => {}
            Some(l) => {
                return match l.ended.take() {
                    Some(Err(e)) => refuse(&e),
                    _ => json!({"ok": true, "status": status_of(s.as_ref().unwrap(), key)}),
                };
            }
            None => return json!({"ok": true, "status": status_of(s.as_ref().unwrap(), key)}),
        }
        s = ENDED.wait(s).unwrap();
    }
}

pub(super) fn status_of(s: &State, key: &str) -> &'static str {
    match s.grants.get(key) {
        Some(g) if !g.rejected => "signed_in",
        _ => "needs_sign_in",
    }
}
