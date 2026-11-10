//! A worktree session's setup script [D202]: run once before the first launch, in a trusted
//! project only, and its state for the thread.

use crate::{Spec, projects, write_atomic};

#[path = "worktree_steps.rs"]
mod steps;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
pub use steps::{Startup, begin, finish};

/// The recorded wrapper launch anchors setup to its input, including after restore [D290].
pub fn setup_launch(item: &serde_json::Value) -> bool {
    item["kind"] == "spawned"
        && item["argv"][0] == "/bin/sh"
        && item["argv"][1] == "-c"
        && item["argv"][5]
            .as_str()
            .is_some_and(|p| p.ends_with("/setup.started"))
}

/// The first launch of a worktree session in a trusted project with a setup script runs the
/// script first, in the worktree, once: its stdin is empty so it can't take the message meant for
/// the agent, its output goes to `setup.log`, and how it ended to `setup.exit`. A failure doesn't
/// stop the agent (proposed). A script started before and never ended was interrupted: it's
/// recorded so and not run again.
pub fn wrap(data: &Path, spec: &Spec, argv: Vec<String>) -> Vec<String> {
    // Once per worktree, recorded with whoever holds it: a "here" fork's runs its holder's, in
    // the worktree that record names [D263, D1080].
    // shortcut: two sharers' first launches at once after a restore may mark the other's run
    // interrupted; give setup its own lock if that shows up.
    let Some(holder) = crate::share::holder(data, spec) else {
        return argv;
    };
    let dir = &holder.dir;
    let worktree = crate::worktrees::folder(dir).unwrap_or(dir.join("worktree"));
    let (started, exit) = (dir.join("setup.started"), dir.join("setup.exit"));
    if exit.exists() {
        return argv;
    }
    if started.exists() {
        let _ = write_atomic(&exit, b"interrupted");
        return argv;
    }
    let script = projects::list(data)
        .unwrap_or_default()
        .into_iter()
        .find(|p| Some(&p.id) == spec.project.as_ref())
        .filter(|p| p.trusted == Some(true))
        .map(|p| p.setup)
        .unwrap_or_default();
    if script.trim().is_empty() {
        return argv;
    }
    let path = |name: &str| dir.join(name).display().to_string();
    // The script stays an argument; each tail update replaces its capped output atomically.
    let line = r#"if (set -C; : >"$2") 2>/dev/null; then
    : >"$3.raw"
    (cd "$5" && /bin/sh -c "$1") </dev/null >"$3.raw" 2>&1 &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
        tail -c 8192 "$3.raw" >"$3.tmp" && mv -f "$3.tmp" "$3"
        sleep 1
    done
    wait "$pid"; code=$?
    tail -c 8192 "$3.raw" >"$3.tmp" && mv -f "$3.tmp" "$3"
    rm -f "$3.raw"
    printf '%s\n' "$code" >"$4.tmp" && mv -f "$4.tmp" "$4"
fi
shift 5; exec "$@""#;
    let head = ["/bin/sh", "-c", line, "sh"].map(String::from);
    let files = [
        script,
        path("setup.started"),
        path("setup.log"),
        path("setup.exit"),
        worktree.display().to_string(),
    ];
    head.into_iter().chain(files).chain(argv).collect()
}

/// How the session's setup script went, for its thread: null when none ran; else running, done,
/// failed (with its code) or interrupted. `alive` says whether its host's child still runs.
fn script_state(dir: &Path, alive: bool) -> serde_json::Value {
    if !dir.join("setup.started").exists() {
        return serde_json::Value::Null;
    }
    let exit = fs::read_to_string(dir.join("setup.exit")).ok();
    let (state, code) = match exit.as_deref().map(str::trim) {
        None if alive => ("running", None),
        None | Some("interrupted") => ("interrupted", None),
        Some("0") => ("done", Some(0)),
        Some(code) => ("failed", code.parse::<i64>().ok()),
    };
    let tail = (|| -> io::Result<String> {
        let mut log = File::open(dir.join("setup.log"))?;
        let start = log.metadata()?.len().saturating_sub(8192);
        log.seek(SeekFrom::Start(start))?;
        let mut bytes = vec![];
        log.take(8192).read_to_end(&mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })()
    .unwrap_or_default();
    serde_json::json!({"state": state, "code": code, "tail": tail})
}

/// The ordered worktree steps reached so far; Local checkout sessions have no record.
pub fn setup_state(dir: &Path, alive: bool) -> serde_json::Value {
    let Some(mut setup) = steps::read(dir) else {
        return serde_json::Value::Null;
    };
    let script = script_state(dir, alive);
    if script.is_object() {
        let failed = script["state"] == "failed" || script["state"] == "interrupted";
        setup["steps"].as_array_mut().unwrap().push(serde_json::json!({
            "kind": "setupScript", "state": if failed { "failed" } else { script["state"].as_str().unwrap() },
            "error": if failed { script["tail"].clone() } else { serde_json::Value::Null },
            "code": script["code"], "interrupted": script["state"] == "interrupted"
        }));
    }
    setup
}
