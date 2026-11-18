//! Local dev sites whose untrusted certificate the person opened anyway, by host, until Clear browsing data.
//! Main reads the file and lets only this computer's hosts through (app/main/browser/localCerts.ts) [D725, D730].

use brigadier_core::write_atomic;
use serde_json::{Value, json};
use std::path::Path;
use std::{fs, io};

pub(super) fn run(folder: &Path, args: &[String]) -> io::Result<Value> {
    let file = folder.join("local-certs.json");
    match crate::arg(args, 0)? {
        "trust" => {
            let host = crate::arg(args, 1)?;
            let plain = |b: u8| b.is_ascii_alphanumeric() || b".-[]:".contains(&b);
            if host.is_empty() || host.len() > 253 || !host.bytes().all(plain) {
                return Err(io::Error::other("Bad host"));
            }
            let mut hosts: Vec<String> = match fs::read(&file) {
                Ok(bytes) => serde_json::from_slice(&bytes)?,
                Err(e) if e.kind() == io::ErrorKind::NotFound => vec![],
                Err(e) => return Err(e),
            };
            if !hosts.iter().any(|h| h == host) {
                hosts.push(host.to_string());
                write_atomic(&file, &serde_json::to_vec(&hosts)?)?;
            }
        }
        "clear" => match fs::remove_file(&file) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        },
        _ => return Err(io::Error::other("Expected trust or clear")),
    }
    Ok(json!({"ok": true}))
}
