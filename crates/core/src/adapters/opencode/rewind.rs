//! Cutting a conversation with OpenCode's own revert [D384]: staged without its files (Brigadier's
//! snapshots do those), then committed, which deletes the messages in place.

use super::super::{Cut, Failed, Landing, Rewound};
use super::server::oneshot;
use crate::Spec;
use serde_json::{Value, json};
use std::path::PathBuf;

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
