//! Codex's own session record (its rollout files): where they are and the diffs they keep.

use super::super::{cli_home, drop_lines, s};
use super::Codex;
use crate::Spec;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Rollouts whose names end with one of `names`: they live under sessions/YYYY/MM/DD/.
/// Per thread in Codex's home: its shell snapshots and generated images [D35].
pub(super) fn thread_files(spec: &crate::Spec, ids: &[String]) -> Vec<PathBuf> {
    let mut paths = vec![];
    let snapshots = super::cli_home(spec, ".codex", "shell_snapshots");
    for id in ids {
        paths.push(super::cli_home(spec, ".codex", "generated_images").join(id));
        paths.extend(
            std::fs::read_dir(&snapshots)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with(&format!("{id}."))
                })
                .map(|e| e.path()),
        );
    }
    paths
}

pub(super) fn rollouts(home: &Path, names: &[String]) -> Vec<PathBuf> {
    let mut found = vec![];
    // Rollouts Codex archived too; older ones are compressed to `.jsonl.zst` [D35].
    let mut dirs = vec![home.join("sessions"), home.join("archived_sessions")];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
            } else if path.file_name().is_some_and(|n| {
                let n = n.to_string_lossy();
                names.iter().any(|id| {
                    n.ends_with(id.as_str())
                        || n.strip_suffix(".zst")
                            .is_some_and(|n| n.ends_with(id.as_str()))
                })
            }) {
                found.push(path);
            }
        }
    }
    found
}

/// The ids of Codex's own helper threads (its Auto reviewer) working for `parents`. Unlike a spawned
/// agent they're no edge in its database: only the parent id in their first line links them [D35].
/// shortcut: a compressed rollout isn't read, so a reviewer Codex archived itself stays; unzip it
/// here if that ever shows up.
pub(super) fn helpers(home: &Path, parents: &[String]) -> Vec<String> {
    use std::io::BufRead;
    let first = |path: &PathBuf| -> Option<Value> {
        let mut line = String::new();
        std::io::BufReader::new(std::fs::File::open(path).ok()?)
            .read_line(&mut line)
            .ok()?;
        serde_json::from_str(&line).ok()
    };
    rollouts(home, &[".jsonl".to_string()])
        .iter()
        .filter_map(first)
        .filter(|v| {
            !s(v, &["payload", "source", "subagent", "other"]).is_empty()
                && parents
                    .iter()
                    .any(|p| p == s(v, &["payload", "parent_thread_id"]))
        })
        .map(|v| s(&v, &["payload", "id"]).to_string())
        .filter(|id| crate::check_id(id).is_ok())
        .collect()
}

/// A rollout's change to one file as a unified diff: an update's own, or a whole added or deleted file.
pub(super) fn diff(c: &Value) -> String {
    let lines = |sign: char| {
        let all: Vec<String> = s(c, &["content"])
            .lines()
            .map(|l| format!("{sign}{l}"))
            .collect();
        (all.len(), all.join("\n"))
    };
    match s(c, &["type"]) {
        "add" => {
            let (n, body) = lines('+');
            format!("@@ -0,0 +1,{n} @@\n{body}")
        }
        "delete" => {
            let (n, body) = lines('-');
            format!("@@ -1,{n} +0,0 @@\n{body}")
        }
        _ => s(c, &["unified_diff"]).to_string(),
    }
}

/// The turns thread `id` holds, kept from the one it was forked from: Norm counts on from them, so
/// diffs() reads the right one.
pub(super) fn held(spec: &crate::Spec, id: &str) -> u64 {
    rollouts(
        &super::cli_home(spec, ".codex", ""),
        &[format!("-{id}.jsonl")],
    )
    .pop()
    .and_then(|path| std::fs::read_to_string(path).ok())
    .map_or(0, |text| {
        (text.lines())
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|v| s(&v["payload"], &["type"]) == "task_started")
            .count() as u64
    })
}

/// What Codex's own delete leaves naming the thread. Its import record's path goes, not the row:
/// without the row Codex would import every rollout again [D371, D382]. Its log rows go too: ones
/// from before the thread had started carry its id only in their text, which Codex's delete, by
/// the id column, misses. A busy or changed database keeps them, and delete still finishes.
pub(super) fn clear_records(spec: &Spec, id: &str) {
    let run = |file: &str, sql: &str, like: String| {
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE;
        if let Ok(db) = Connection::open_with_flags(super::cli_home(spec, ".codex", file), flags) {
            let _ = db.busy_timeout(Duration::from_secs(2));
            let _ = db.execute(sql, [like]);
        }
    };
    run(
        "state_5.sqlite",
        "UPDATE backfill_state SET last_watermark = NULL WHERE id = 1 AND instr(last_watermark, ?1) > 0",
        format!("-{id}.jsonl"),
    );
    run(
        "logs_2.sqlite",
        "DELETE FROM logs WHERE instr(feedback_log_body, ?1) > 0",
        id.to_string(),
    );
}

/// One thread: Codex's delete, then its prompt history and name by thread id, and a writer lock a
/// killed process left; one a live writer holds stays, by Codex's own rule [D35].
pub(super) fn forget_thread(codex: &Codex, spec: &Spec, id: &str) -> Result<(), String> {
    super::delete_thread(codex, spec, id)?;
    clear_records(spec, id);
    for (file, key) in [
        ("history.jsonl", "session_id"),
        ("session_index.jsonl", "id"),
    ] {
        drop_lines(&cli_home(spec, ".codex", file), key, id).map_err(|e| e.to_string())?;
    }
    let lock = cli_home(spec, ".codex", "thread-writer-locks").join(format!("{id}.lock"));
    if let Ok(f) = std::fs::File::open(&lock)
        && f.try_lock().is_ok()
    {
        let _ = std::fs::remove_file(&lock);
    }
    Ok(())
}
