//! Send feedback [D353, D2017]: a new-issue page on Brigadier's repository, filled with the note,
//! this app's version, macOS's and each agent CLI's, for the user to post in the browser. Brigadier
//! sends nothing itself [D2022].

use brigadier_core::adapters;
use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use std::process::Command;

const REPO: &str = "https://github.com/syncra-studio/brigadier";
/// Proposed, as the old app's: the longest link opened; past it the note is cut, so GitHub takes it.
const MAX_URL: usize = 7500;
/// Proposed, as the old app's: the title is the note's first line, cut at this many characters.
const MAX_TITLE: usize = 72;

/// `feedback <note>`: the prefilled page's link.
pub fn run(data: &Path, note: &str) -> Value {
    let note = note.trim();
    let details = details(data).join(", ");
    let whole = link(note, &details);
    if whole.len() <= MAX_URL {
        return json!({"ok": true, "url": whole});
    }
    // The most of the note that still fits, by whole characters.
    let chars: Vec<char> = note.chars().collect();
    let cut = |n: usize| format!("{}…", chars[..n].iter().collect::<String>().trim_end());
    let (mut fits, mut over) = (0, chars.len());
    while over - fits > 1 {
        let middle = (fits + over) / 2;
        match link(&cut(middle), &details).len() <= MAX_URL {
            true => fits = middle,
            false => over = middle,
        }
    }
    json!({"ok": true, "url": link(&cut(fits), &details)})
}

fn link(note: &str, details: &str) -> String {
    let line = note.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    let title = match line.chars().count() <= MAX_TITLE {
        true => line,
        false => format!(
            "{}…",
            line.chars()
                .take(MAX_TITLE - 1)
                .collect::<String>()
                .trim_end()
        ),
    };
    let body = format!("{note}\n\n{details}");
    format!(
        "{REPO}/issues/new?title={}&body={}",
        encode(&title),
        encode(&body)
    )
}

/// "Brigadier 0.1.0 (build 2100)", "macOS 27.0 (arm64)", then each agent CLI found, by its last check.
fn details(data: &Path) -> Vec<String> {
    let build = brigadier_frames::wire::build();
    let mut out = vec![match build {
        0 => format!("Brigadier {}", env!("CARGO_PKG_VERSION")),
        b => format!("Brigadier {} (build {b})", env!("CARGO_PKG_VERSION")),
    }];
    let macos = Command::new("sw_vers").arg("-productVersion").output();
    if let Ok(v) = macos.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()) {
        // shortcut: the chip type is proposed metadata beside the version D2022 names; drop it if unwanted.
        out.push(format!(
            "macOS {v} ({})",
            match std::env::consts::ARCH {
                "aarch64" => "arm64",
                arch => arch,
            }
        ));
    }
    for a in adapters::all() {
        let checks: Value = fs::read(data.join("agents").join(format!("{}.json", a.name())))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let version = (checks.as_object().into_iter().flat_map(|m| m.values()))
            .find_map(|c| c["version"].as_str().filter(|v| !v.is_empty()));
        // The number alone: CLIs say "2.1.0 (Claude Code)" or "codex-cli 0.50.0".
        let version = version.map(|v| {
            (v.split_whitespace())
                .find(|w| w.starts_with(|c: char| c.is_ascii_digit()))
                .unwrap_or(v)
        });
        if let Some(v) = version {
            out.push(format!("{} {v}", a.label()));
        }
    }
    out
}

/// A query value, percent-encoded but for URL-safe characters.
fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
