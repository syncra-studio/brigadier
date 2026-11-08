//! Codex's own session record (its rollout files): where they are and the diffs they keep.

use super::super::{home_path, s};
use serde_json::Value;
use std::path::PathBuf;

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

pub(super) fn rollouts(names: &[String]) -> Vec<PathBuf> {
    let mut found = vec![];
    // Rollouts Codex archived too; older ones are compressed to `.jsonl.zst` [D35].
    let mut dirs = vec![
        home_path(".codex/sessions"),
        home_path(".codex/archived_sessions"),
    ];
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
