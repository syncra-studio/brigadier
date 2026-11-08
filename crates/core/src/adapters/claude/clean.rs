//! What Claude Code writes for one session outside its folder, by exact path [D35].

use super::project_dir;
use crate::Spec;
use crate::adapters::cli_home;
use std::path::PathBuf;

/// Its transcript and the folder beside it, transcripts it set aside (`<id>.orphaned-…`,
/// `<id>.jsonl.superseded-…`), and per session in its home: checkpoints, environment, task list,
/// debug log; and its scratch folder.
pub(super) fn external(spec: &Spec, resume: &str) -> Vec<PathBuf> {
    let dir = project_dir(spec);
    let mut paths = vec![dir.join(format!("{resume}.jsonl")), dir.join(resume)];
    paths.extend(
        std::fs::read_dir(&dir)
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
    for rest in ["file-history", "session-env", "tasks"] {
        paths.push(cli_home(spec, ".claude", rest).join(resume));
    }
    paths.push(cli_home(spec, ".claude", "debug").join(format!("{resume}.txt")));
    paths.push(scratch(spec).join(resume));
    paths
}

/// Its scratch folder for the session's folder, under `/tmp/claude-<uid>`.
pub(super) fn scratch(spec: &Spec) -> PathBuf {
    let uid = unsafe { libc::getuid() };
    let slug = project_dir(spec)
        .file_name()
        .map(PathBuf::from)
        .unwrap_or_default();
    PathBuf::from(format!("/tmp/claude-{uid}")).join(slug)
}
