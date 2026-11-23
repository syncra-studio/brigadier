//! `!` commands from the composer [D316, D320]: each runs at once in its session's folder, on its
//! own host (`term-<command id>`) over pipes, even while the agent works, with no timeout. Its
//! start and end are notes in the session's log, which fold into its Shell row; its output stays
//! in its own log, read on demand. The session's `commands/` folder names its commands, so a sweep
//! keeps them while the session does [repo D35].
//!
//! `shell <session> run <command id> <line>` (safe to send twice), `stop <command id>`, `output
//! <command id>` (its plain tail and whether it runs), and `shell settle` at the daemon's start:
//! a command whose end was never noted gets it, or a waiter again.

use super::{lock_sweep, tail};
use crate::{arg, owner};
use brigadier_core::{self as core, Spec, TERM, adapters, session};
use brigadier_frames::log::{self, Reader};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;
use std::thread;
use std::time::Duration;

/// What the row shows of a finished command: its newest output.
const SHOWN: usize = 16 << 10;
/// What `output` answers while it runs.
const LIVE: usize = 64 << 10;

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    if arg(args, 1)? == "settle" {
        settle(data);
        return Ok(json!({"ok": true}));
    }
    let (sid, op, cmd) = (arg(args, 1)?, arg(args, 2)?, arg(args, 3)?);
    core::check_id(cmd)?;
    let id = format!("{TERM}{cmd}");
    if !core::session_dir(data, sid)
        .join("commands")
        .join(cmd)
        .exists()
        && op != "run"
    {
        return Err(io::Error::other("No such command"));
    }
    match op {
        "run" => start(data, sid, cmd, arg(args, 4)?),
        "stop" => {
            let _ = owner::call(data, &id, json!({"op": "stop", "by": "user"}));
            Ok(json!({"ok": true}))
        }
        "output" => {
            let dir = core::session_dir(data, &id);
            let text = plain(&tail(&dir, LIVE));
            Ok(json!({"ok": true, "output": text, "running": ended(&dir).is_none()}))
        }
        _ => Err(io::Error::other(format!("unknown shell command {op}"))),
    }
}

fn start(data: &Path, sid: &str, cmd: &str, line: &str) -> io::Result<Value> {
    let started = {
        let spec = core::load(data, sid)?;
        // Archived, going or mid-rewind: no new work; then the sweep's lock, so none misses it.
        let _fence = session::fence(data, &spec)?;
        let _sweep = lock_sweep(data)?;
        let mark = spec.dir.join("commands").join(cmd);
        if mark.exists() {
            return Ok(json!({"ok": true}));
        }
        spawn(data, &spec, cmd, line, &mark)?
    };
    match started {
        Ok(reply) if reply["ok"] == true => {
            let (data, sid, cmd) = (data.to_path_buf(), sid.to_string(), cmd.to_string());
            thread::spawn(move || wait(&data, &sid, &cmd));
            Ok(json!({"ok": true}))
        }
        Ok(reply) => end(
            data,
            sid,
            cmd,
            Some(reply["error"].as_str().unwrap_or("It didn't start")),
        ),
        Err(e) => end(data, sid, cmd, Some(&e.to_string())),
    }
}

/// Marks and notes the command, then starts it on its host: the start's own failure is its row's.
fn spawn(
    data: &Path,
    spec: &Spec,
    cmd: &str,
    line: &str,
    mark: &Path,
) -> io::Result<io::Result<Value>> {
    fs::create_dir_all(mark.parent().unwrap())?;
    owner::ensure(data, spec)?;
    let note = json!({"event": "shell", "phase": "start", "id": cmd, "command": line});
    owner::call(data, &spec.id, json!({"op": "note", "data": note}))?;
    fs::write(mark, "")?;
    // The lead hears of it with its next input, never woken [D316].
    let _ = crate::workers::told_shell(data, &spec.id, cmd, "run");
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let run = Spec {
        id: format!("{TERM}{cmd}"),
        backend: "shell".into(),
        mode: "pipe".into(),
        cwd: spec.cwd.clone(),
        created: log::now_ms(),
        ..Default::default()
    };
    let mut env = adapters::base_env(&run, Path::new(&shell), &[]);
    env.push(("SHELL".into(), shell.clone()));
    // Over pipes Python holds its output back; a dev server's address should show as printed.
    env.push(("PYTHONUNBUFFERED".into(), "1".into()));
    env.push((
        "LOGNAME".into(),
        std::env::var("LOGNAME").unwrap_or_default(),
    ));
    let env: serde_json::Map<String, Value> = env.into_iter().map(|(k, v)| (k, v.into())).collect();
    Ok(core::create(data, &run).and_then(|run| {
        owner::ensure(data, &run)?;
        let req = json!({"op": "spawn", "argv": [shell, "-l", "-c", line], "env": env, "cwd": run.cwd, "pty": false, "backend": "shell"});
        owner::call(data, &run.id, req)
    }))
}

/// How it ended, from its log: (exit code, signal, start and end times), once it has.
pub(super) fn ended(dir: &Path) -> Option<(Value, Value, u64, u64)> {
    let mut r = Reader::open(&dir.join("log"), 0, 0).ok()?;
    let (mut from, mut out) = (0, None);
    while let Ok(Some(f)) = r.next_with(|k| matches!(k, log::SPAWNED | log::EXITED)) {
        let v: Value = serde_json::from_slice(&f.data).unwrap_or_default();
        if f.kind == log::SPAWNED {
            from = f.ts;
        } else if f.kind == log::EXITED {
            out = Some((v["code"].clone(), v["signal"].clone(), from, f.ts));
        }
    }
    out
}

/// Waits for the command to end, then notes it. Its host gone without an end (the Mac restarted)
/// ends it too.
fn wait(data: &Path, sid: &str, cmd: &str) {
    let (id, dir) = (
        format!("{TERM}{cmd}"),
        core::session_dir(data, &format!("{TERM}{cmd}")),
    );
    while ended(&dir).is_none() && owner::state(data, &id) != core::fold::Owner::Dead {
        thread::sleep(Duration::from_millis(300));
    }
    let _ = end(data, sid, cmd, None);
}

/// Notes how it ended in the session's log, once, and lets its host go; its log stays.
fn end(data: &Path, sid: &str, cmd: &str, failed: Option<&str>) -> io::Result<Value> {
    let _sweep = lock_sweep(data)?;
    let mark = core::session_dir(data, sid).join("commands").join(cmd);
    if fs::read_to_string(&mark).is_ok_and(|m| m == "ended") {
        return Ok(json!({"ok": true}));
    }
    let (id, dir) = (
        format!("{TERM}{cmd}"),
        core::session_dir(data, &format!("{TERM}{cmd}")),
    );
    let output = plain(&tail(&dir, SHOWN));
    let mut note = json!({"event": "shell", "phase": "end", "id": cmd, "output": output});
    match (failed, ended(&dir)) {
        (Some(why), _) => (note["progress"], note["error"]) = ("failed".into(), why.into()),
        (None, Some((code, signal, from, to))) => {
            note["progress"] = (if signal.is_null() {
                "done"
            } else {
                "cancelled"
            })
            .into();
            (note["exitCode"], note["ms"]) = (code, to.saturating_sub(from).into());
        }
        (None, None) => {
            (note["progress"], note["error"]) = ("failed".into(), "Its host ended".into())
        }
    }
    let spec = core::load(data, sid)?;
    owner::ensure(data, &spec)?;
    owner::call(data, sid, json!({"op": "note", "data": note}))?;
    fs::write(&mark, "ended")?;
    let _ = crate::workers::told_shell(data, sid, cmd, "end");
    let _ = owner::release(data, &id);
    Ok(json!({"ok": failed.is_none(), "error": failed}))
}

/// Each command whose end was never noted: noted now if it's over, else waited for again.
fn settle(data: &Path) {
    for sid in core::ids(data) {
        let dir = core::session_dir(data, &sid).join("commands");
        for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
            let cmd = entry.file_name().to_string_lossy().to_string();
            if fs::read_to_string(entry.path()).is_ok_and(|m| m == "ended")
                || core::check_id(&cmd).is_err()
            {
                continue;
            }
            let (data, sid) = (data.to_path_buf(), sid.clone());
            thread::spawn(move || wait(&data, &sid, &cmd));
        }
    }
}

/// Output as plain text: colours and other escapes gone, a line redrawn with `\r` (a progress
/// bar) or backspaces only as it was last drawn.
pub(crate) fn plain(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        // A backspace takes back what it steps over (a shell redrawing its line).
        if c == '\x08' {
            if !out.ends_with('\n') {
                out.pop();
            }
            continue;
        }
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: parameters, then one final byte.
            Some('[') => while chars.next().is_some_and(|c| !('@'..='~').contains(&c)) {},
            // OSC: up to BEL or ESC \.
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' || (c == '\x1b' && chars.next_if_eq(&'\\').is_some()) {
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    let lines = out.split('\n').map(|l| l.trim_end_matches('\r'));
    lines
        .map(|l| l.rsplit('\r').next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}
