//! Cutting a conversation with OpenCode's own revert [D384]: staged without its files (Brigadier's
//! snapshots do those), then committed, which deletes the messages in place.

use super::super::{Cut, Failed, Landing, Rewound};
use super::http::Server;
use crate::Spec;
use brigadier_frames::base64;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

type Env = Vec<(String, String)>;

fn said(step: &str, code: u16, body: &str) -> String {
    format!("OpenCode's {step} said {code}: {body}")
}

pub(super) fn cut(
    exe: Option<PathBuf>,
    env: Env,
    spec: &Spec,
    resume: &str,
    cut: &Cut,
) -> Result<Rewound, Failed> {
    let exe = exe.ok_or_else(|| Failed::Refused("OpenCode is not installed".into()))?;
    let message = cut.dropped.start.as_deref().unwrap_or("");
    oneshot(&exe, env, &spec.cwd, |server| {
        let at = format!("/api/session/{resume}/revert");
        let stage = json!({"messageID": message, "files": false});
        match server.request("POST", &format!("{at}/stage"), &stage) {
            Ok((code, _)) if code < 300 => {}
            Ok((code, body)) if code < 500 => {
                return Err(Failed::Refused(said("revert", code, &body)));
            }
            Ok((code, body)) => return Err(Failed::Uncertain(said("revert", code, &body))),
            Err(e) => return Err(Failed::Uncertain(e.to_string())),
        }
        match server.request("POST", &format!("{at}/commit"), &Value::Null) {
            Ok((code, _)) if code < 300 => Ok(Rewound::default()),
            Ok((code, body)) => Err(Failed::Uncertain(said("commit", code, &body))),
            Err(e) => Err(Failed::Uncertain(e.to_string())),
        }
    })
    .map_err(Failed::Refused)?
}

/// Its own record decides: the first dropped message gone is a cut that landed. Still there, any
/// staged revert is undone so the conversation stands as it was.
pub(super) fn landed(
    exe: Option<PathBuf>,
    env: Env,
    spec: &Spec,
    resume: &str,
    cut: &Cut,
) -> Landing {
    let Some(exe) = exe else {
        return Landing::Unknown("OpenCode is not installed".into());
    };
    let message = cut.dropped.start.as_deref().unwrap_or("");
    let found = oneshot(&exe, env, &spec.cwd, |server| {
        let at = format!("/api/session/{resume}");
        match server.request("GET", &format!("{at}/message/{message}"), &Value::Null) {
            Ok((404, _)) => Landing::Applied(Rewound::default()),
            Ok((code, _)) if code < 300 => match server.request("GET", &at, &Value::Null) {
                Ok((code, body)) if code < 300 => {
                    let v: Value = serde_json::from_str(&body).unwrap_or_default();
                    if !v["data"].is_object() {
                        return Landing::Unknown(said("session", code, &body));
                    }
                    if v["data"]["revert"].is_object() {
                        match server.request("DELETE", &format!("{at}/revert"), &Value::Null) {
                            Ok((code, _)) if code < 300 => {}
                            Ok((code, body)) => return Landing::Unknown(said("undo", code, &body)),
                            Err(e) => return Landing::Unknown(e.to_string()),
                        }
                    }
                    Landing::NotApplied
                }
                Ok((code, body)) => Landing::Unknown(said("session", code, &body)),
                Err(e) => Landing::Unknown(e.to_string()),
            },
            Ok((code, body)) => Landing::Unknown(said("message", code, &body)),
            Err(e) => Landing::Unknown(e.to_string()),
        }
    });
    found.unwrap_or_else(Landing::Unknown)
}

/// A server for one bounded job, in the session's environment and folder, ended when it returns.
fn oneshot<T>(
    exe: &std::path::Path,
    env: Vec<(String, String)>,
    cwd: &str,
    job: impl FnOnce(&Server) -> T,
) -> Result<T, String> {
    let password = super::super::uuid();
    let mut command = Command::new(exe);
    command
        .args(["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"])
        .env_clear()
        .envs(env)
        .env("OPENCODE_PASSWORD", &password)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = brigadier_frames::spawn::grouped(&mut command)
        .map_err(|e| format!("OpenCode didn't start: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut first = String::new();
        let _ = BufReader::new(stdout).read_line(&mut first);
        let _ = tx.send(first);
    });
    let first = rx.recv_timeout(Duration::from_secs(60));
    let answered = first.map_err(|_| "OpenCode's server didn't start".to_string());
    let out = answered.and_then(|first| {
        let url: Value =
            serde_json::from_str(&first).map_err(|_| format!("OpenCode said {first:?}"))?;
        let server = Server {
            addr: super::super::s(&url, &["url"])
                .trim_start_matches("http://")
                .into(),
            auth: base64(format!("opencode:{password}").as_bytes()),
        };
        Ok(job(&server))
    });
    brigadier_frames::spawn::kill_tree(child.id());
    let _ = child.wait();
    out
}
