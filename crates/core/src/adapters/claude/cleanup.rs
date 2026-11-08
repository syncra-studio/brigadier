//! Per-conversation files, recorded before removal so delete can retry after a failure.

use super::{project_dir, project_slug};
use crate::Spec;
use crate::adapters::{cli_home, drop_lines, s};
use std::collections::BTreeSet;
use std::path::PathBuf;
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

pub fn external(spec: &Spec, resume: &str) -> Vec<PathBuf> {
    let dir = project_dir(spec);
    let mut paths = recorded(spec, resume).unwrap_or_default();
    paths.extend([
        dir.join(format!("{resume}.jsonl")),
        dir.join(resume),
        cli_home(spec, ".claude", "session-env").join(resume),
    ]);
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
    for (temp, cwd) in roots {
        paths.push(
            temp.join(format!("claude-{}", unsafe { libc::getuid() }))
                .join(project_slug(&cwd))
                .join(resume),
        );
    }
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
