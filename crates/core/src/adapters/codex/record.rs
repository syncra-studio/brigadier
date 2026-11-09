//! Codex's own session record (its rollout files): where they are and the diffs they keep.

use super::super::s;
use serde_json::Value;
use std::path::{Path, PathBuf};

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
