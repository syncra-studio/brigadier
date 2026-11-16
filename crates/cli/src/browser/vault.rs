//! A profile's saved passwords (the old app's browserVault.ts): one sealed file in the profile's folder, so deleting
//! a profile takes them along and clearing its browsing data doesn't. The key is in Brigadier's one Keychain item
//! [D2043, D449]. Only the app's page reaches these, never an agent, and nothing logs a value [D516].

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use brigadier_core::{self as core, library::secrets};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs;
use std::io::{self, Read};
use std::path::Path;

const FILE: &str = "Brigadier Vault";
const ITEM: &str = "browser_vault";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Login {
    id: u64,
    site: String,
    username: String,
    password: String,
    created_ms: i64,
    used_ms: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vault {
    next_id: u64,
    logins: Vec<Login>,
    never: Vec<String>,
}

/// What an import hands over: an address (any page of the site), a username (may be empty) and a password.
#[derive(Deserialize)]
struct Imported {
    url: String,
    username: String,
    password: String,
}

fn random<const N: usize>() -> io::Result<[u8; N]> {
    let mut bytes = [0; N];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The vaults' key; `make`: one is made the first time a vault is written.
fn key(data: &Path, make: bool) -> io::Result<Option<Aes256Gcm>> {
    let saved = secrets::read(data)?;
    let mut text = saved
        .get(ITEM)
        .and_then(|v| v["key"].as_str())
        .map(String::from);
    if text.is_none() && make {
        let made = hex(&random::<32>()?);
        secrets::update(data, |all| {
            all.insert(ITEM.into(), json!({ "key": made }));
        })?;
        text = Some(made);
    }
    let Some(text) = text else { return Ok(None) };
    let bytes: Vec<u8> = (0..text.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect();
    let key: [u8; 32] = bytes.try_into().map_err(|_| unreadable())?;
    Ok(Some(Aes256Gcm::new(&key.into())))
}

fn unreadable() -> io::Error {
    io::Error::other("The saved passwords can't be opened.")
}

/// The vault, or an empty one when there is no file. One that can't be opened fails, so a write can't replace it.
fn read(data: &Path, folder: &Path) -> io::Result<Vault> {
    let sealed = match fs::read(folder.join(FILE)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok(Vault {
                next_id: 1,
                logins: vec![],
                never: vec![],
            });
        }
        Err(e) => return Err(e),
    };
    let cipher = key(data, false)?.ok_or_else(unreadable)?;
    let (nonce, body) = sealed.split_at_checked(12).ok_or_else(unreadable)?;
    let nonce = Nonce::try_from(nonce).map_err(|_| unreadable())?;
    let open = cipher.decrypt(&nonce, body).map_err(|_| unreadable())?;
    serde_json::from_slice(&open).map_err(|_| unreadable())
}

fn write(data: &Path, folder: &Path, vault: &Vault) -> io::Result<()> {
    let cipher = key(data, true)?.ok_or_else(unreadable)?;
    let nonce = random::<12>()?;
    let body = serde_json::to_vec(vault)?;
    let sealed = cipher
        .encrypt(&Nonce::from(nonce), body.as_slice())
        .map_err(|_| unreadable())?;
    core::write_atomic(&folder.join(FILE), &[&nonce[..], &sealed].concat())
}

/// The site a password belongs to: its origin, for http and https only.
pub(super) fn login_site(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let host = rest.split(['/', '?', '#']).next()?.rsplit('@').next()?;
    let host = host.to_ascii_lowercase();
    let default = (scheme == "https" && host.ends_with(":443"))
        || (scheme == "http" && host.ends_with(":80"));
    let host = if default {
        host.rsplit_once(':')?.0.to_string()
    } else {
        host
    };
    (matches!(scheme.as_str(), "http" | "https") && !host.is_empty())
        .then(|| format!("{scheme}://{host}"))
}

/// Saves one login: a known site and username takes the new password.
fn put(vault: &mut Vault, site: &str, username: &str, password: &str, now: i64) -> &'static str {
    match vault
        .logins
        .iter_mut()
        .find(|l| l.site == site && l.username == username)
    {
        None => {
            vault.logins.push(Login {
                id: vault.next_id,
                site: site.into(),
                username: username.into(),
                password: password.into(),
                created_ms: now,
                used_ms: now,
            });
            vault.next_id += 1;
            "added"
        }
        Some(known) if known.password == password => "unchanged",
        Some(known) => {
            known.password = password.into();
            known.used_ms = now;
            "updated"
        }
    }
}

pub(super) fn run(data: &Path, folder: &Path, args: &[String]) -> io::Result<Value> {
    let get = |i| crate::arg(args, i);
    let mut vault = read(data, folder)?;
    let now = super::now();
    let site =
        |i| login_site(get(i)?).ok_or_else(|| io::Error::other("A password needs a web address."));
    match get(0)? {
        "list" => {
            let logins: Vec<_> = (vault.logins.iter())
                .map(|l| json!({"id": l.id, "site": l.site, "username": l.username}))
                .collect();
            return Ok(json!({"ok": true, "logins": logins}));
        }
        "reveal" => {
            let id: u64 = get(1)?.parse().map_err(io::Error::other)?;
            let login = vault.logins.iter().find(|l| l.id == id);
            let login = login.ok_or_else(|| io::Error::other("That password is gone."))?;
            return Ok(json!({"ok": true, "password": login.password}));
        }
        // A page's sign-in form: what fills it, and whether the site asked never to be offered a save.
        "fill" => {
            let site = site(1)?;
            let logins: Vec<_> = (vault.logins.iter().filter(|l| l.site == site))
                .map(|l| json!({"username": l.username, "password": l.password, "usedMs": l.used_ms}))
                .collect();
            return Ok(
                json!({"ok": true, "site": site, "logins": logins, "never": vault.never.contains(&site)}),
            );
        }
        "never" => return Ok(json!({"ok": true, "never": vault.never})),
        "add" => {
            let site = site(1)?;
            if get(3)?.is_empty() {
                return Err(io::Error::other(
                    "A password needs a web address and a password.",
                ));
            }
            put(&mut vault, &site, get(2)?, get(3)?, now);
        }
        // A saved login signed in again: only its date changes.
        "used" => {
            let (site, username) = (site(1)?, get(2)?);
            let found =
                (vault.logins.iter_mut()).find(|l| l.site == site && l.username == username);
            found
                .ok_or_else(|| io::Error::other("That password is gone."))?
                .used_ms = now;
        }
        "remove" => {
            let id: u64 = get(1)?.parse().map_err(io::Error::other)?;
            vault.logins.retain(|l| l.id != id);
        }
        "never-add" => {
            let site = site(1)?;
            if !vault.never.contains(&site) {
                vault.never.push(site);
            }
        }
        "allow" => {
            let site = get(1)?;
            vault.never.retain(|s| s != site);
        }
        // An import's logins: added to the vault, or with `replace` in place of its logins (the never list stays).
        op @ ("import" | "replace") => {
            let items: Vec<Imported> = serde_json::from_str(get(1)?)?;
            let old = std::mem::take(&mut vault.logins);
            if op == "import" {
                vault.logins = old.clone();
            }
            let mut counts = json!({"added": 0, "updated": 0, "unchanged": 0, "skipped": 0});
            for item in items {
                let site = login_site(&item.url);
                let repeat = |s: &str| {
                    op == "replace"
                        && vault
                            .logins
                            .iter()
                            .any(|l| l.site == s && l.username == item.username)
                };
                let Some(site) = site.filter(|s| !item.password.is_empty() && !repeat(s)) else {
                    counts["skipped"] = (counts["skipped"].as_u64().unwrap() + 1).into();
                    continue;
                };
                // Replacing, a login that stays keeps its id and dates.
                if op == "replace"
                    && let Some(known) = old
                        .iter()
                        .find(|l| l.site == site && l.username == item.username)
                {
                    vault.logins.push(known.clone());
                }
                let done = put(&mut vault, &site, &item.username, &item.password, now);
                counts[done] = (counts[done].as_u64().unwrap() + 1).into();
            }
            write(data, folder, &vault)?;
            return Ok(json!({"ok": true, "counts": counts}));
        }
        _ => return Err(io::Error::other("Unknown browser vault operation")),
    }
    write(data, folder, &vault)?;
    Ok(json!({"ok": true}))
}
