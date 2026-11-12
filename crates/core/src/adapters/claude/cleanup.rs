//! Per-conversation files, recorded before removal so delete can retry after a failure.

use crate::Spec;
use crate::adapters::{cli_home, drop_lines, home_path, s};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::{fs, io};

fn manifest(spec: &Spec, resume: &str) -> PathBuf {
    spec.dir.join(format!("claude-{resume}.paths"))
}

fn recorded(spec: &Spec, resume: &str) -> io::Result<Vec<PathBuf>> {
    match fs::read(manifest(spec, resume)) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e),
    }
}

/// Claude's temp roots for this session: each folder a host recorded, then the defaults.
fn temp_roots(spec: &Spec) -> BTreeSet<(PathBuf, PathBuf)> {
    let mut roots = BTreeSet::new();
    let _ = crate::read(&spec.dir, |item| {
        if item["kind"] == "spawned" && item["backend"] == "claude" {
            let temp = s(item, &["temp_dir"]);
            let cwd = s(item, &["cwd"]);
            if !temp.is_empty() && !cwd.is_empty() {
                roots.insert((PathBuf::from(temp), PathBuf::from(cwd)));
            }
        }
    });
    // Older hosts did not record TMPDIR; macOS also documents /private/tmp as its default.
    roots.insert((std::env::temp_dir(), PathBuf::from(&spec.cwd)));
    #[cfg(target_os = "macos")]
    roots.insert((PathBuf::from("/private/tmp"), PathBuf::from(&spec.cwd)));
    roots
}

/// Its per-folder scratch folders under `claude-<uid>`.
pub fn scratch(spec: &Spec) -> Vec<PathBuf> {
    temp_roots(spec)
        .into_iter()
        .map(|(temp, cwd)| {
            temp.join(format!("claude-{}", unsafe { libc::getuid() }))
                .join(project_slug(&cwd))
        })
        .collect()
}

/// Its transcript and the folder beside it, transcripts it set aside (`<id>.orphaned-…`,
/// `<id>.jsonl.superseded-…`), and per session in its home: checkpoints, environment, task list,
/// debug log; and its temp folders.
pub fn external(spec: &Spec, resume: &str) -> Vec<PathBuf> {
    let dir = project_dir(spec);
    let mut paths = recorded(spec, resume).unwrap_or_default();
    paths.extend([
        dir.join(format!("{resume}.jsonl")),
        dir.join(resume),
        cli_home(spec, ".claude", "debug").join(format!("{resume}.txt")),
    ]);
    for rest in ["file-history", "session-env", "tasks"] {
        paths.push(cli_home(spec, ".claude", rest).join(resume));
    }
    paths.extend(
        fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(&format!("{resume}."))
            })
            .map(|e| e.path()),
    );
    paths.extend(scratch(spec).into_iter().map(|p| p.join(resume)));
    paths.sort();
    paths.dedup();
    // Keep shared lastSessionId, plugin usage rows and project memory; no project-wide purge.
    paths
}

pub fn forget(spec: &Spec, resume: &str) -> io::Result<()> {
    recorded(spec, resume)?;
    crate::write_atomic(
        &manifest(spec, resume),
        &serde_json::to_vec(&external(spec, resume))?,
    )?;
    drop_lines(
        &cli_home(spec, ".claude", "history.jsonl"),
        "sessionId",
        resume,
    )?;
    Ok(())
}

/// Where the CLI keeps transcripts for a working folder: its real path with every
/// non-alphanumeric character turned into '-'.
pub(super) fn project_dir(spec: &Spec) -> PathBuf {
    home_path(".claude/projects").join(project_slug(Path::new(&spec.cwd)))
}

fn project_slug(cwd: &Path) -> String {
    let real = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    real.display()
        .to_string()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}
