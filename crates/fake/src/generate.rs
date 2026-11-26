//! Synthetic session logs for the scale drill (`gen`).

use super::now;
use brigadier_frames::log;
use serde_json::json;
use std::fs;
use std::io;
use std::path::Path;

/// Writes a synthetic session of about `bytes` bytes: many turns of realistic agent output.
pub(super) fn generate(dir: &Path, id: &str, bytes: u64) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let spec = json!({"id": id, "backend": "fake", "mode": "pipe", "cwd": "/tmp", "model": null, "opts": {}, "created": now()});
    fs::write(dir.join("session.json"), spec.to_string())?;
    let mut w = log::Writer::open(&dir.join("log"))?;
    let spawned = json!({"pid": 999_999, "pgid": 999_999, "start_us": 1, "backend": "fake", "mode": "pipe", "cli_version": "fake 1"});
    w.append(log::SPAWNED, spawned.to_string().as_bytes(), false)?;
    w.append(
        log::OUT,
        format!("{}\n", json!({"t": "hello", "session": format!("fk{id}")})).as_bytes(),
        false,
    )?;
    let filler = "lorem ipsum dolor sit amet ".repeat(8);
    let mut turn = 0u64;
    while w.len < bytes {
        let cid = format!("g{turn}");
        w.append(log::INTENT, json!({"cid": cid, "origin": "user", "text": format!("message {turn}"), "backend": "fake"}).to_string().as_bytes(), false)?;
        w.append(
            log::DELIVERED,
            json!({"cid": cid}).to_string().as_bytes(),
            false,
        )?;
        let mut chunk = format!("{}\n", json!({"t": "turn"}));
        for i in 0..40 {
            chunk += &format!("{}\n", json!({"t": "say", "text": format!("{i} {filler}")}));
            if i % 10 == 0 {
                chunk += &format!(
                    "{}\n{}\n",
                    json!({"t": "tool", "id": format!("t{turn}-{i}"), "name": "tree"}),
                    json!({"t": "beat", "n": 1})
                );
                chunk += &format!(
                    "{}\n",
                    json!({"t": "tool_done", "id": format!("t{turn}-{i}")})
                );
            }
            if chunk.len() > 8 << 10 {
                w.append(log::OUT, chunk.as_bytes(), false)?;
                chunk.clear();
            }
        }
        chunk += &format!("{}\n", json!({"t": "done"}));
        w.append(log::OUT, chunk.as_bytes(), false)?;
        turn += 1;
    }
    Ok(())
}
