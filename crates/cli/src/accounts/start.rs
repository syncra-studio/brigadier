//! The account a new session starts on [D2082], and what it says when that isn't its Use pick [C36].

use super::{accounts_of, agent, check, load, on_account, usable};
use crate::{switching, usage};
use brigadier_core::Spec;
use brigadier_core::adapters::{self, Adapter};
use serde_json::{Value, json};
use std::path::Path;

/// A new session's spec with the account it starts on [D2082]: the one picked with Use while it is
/// still added and usable, else the computer's login. A session already made never moves.
pub(crate) fn starting(data: &Path, spec: Spec) -> Spec {
    picked(data, spec).0
}

/// The same, with what the check of its Use pick said, where one ran.
pub(crate) fn picked(data: &Path, spec: Spec) -> (Spec, Option<Value>) {
    let v = load(data);
    let id = v["use"][&spec.backend].as_str().unwrap_or("");
    let home = adapters::home_path("").display().to_string();
    let added = !id.is_empty() && accounts_of(&v, &spec.backend).iter().any(|(x, _)| x == id);
    let c = (added.then(|| agent(&spec.backend).ok()).flatten()).map(|a| check(a, data, id, &home));
    let starts_on = c.as_ref().filter(|c| usable(c)).map(|_| id.to_string());
    (Spec { starts_on, ..spec }, c)
}

/// What a new session on `spec` says when the account picked with Use, checked `c`, can't take it
/// [C36, C38]: it starts on the computer's login, which Providers shows while its last check found
/// it signed in [D2065], and its thread says why (words proposed); with that login signed out it
/// doesn't start (Err, its words).
pub(crate) fn fell_back(
    data: &Path,
    spec: &Spec,
    c: Option<&Value>,
) -> Result<Option<String>, String> {
    let v = load(data);
    let id = v["use"][&spec.backend].as_str().unwrap_or("");
    let a = match agent(&spec.backend) {
        Ok(a) if !id.is_empty() && spec.starts_on.is_none() => a,
        _ => return Ok(None),
    };
    let why = match c.map(|c| &c["signed_in"]) {
        Some(Value::Bool(true)) => "can't be used for chats",
        Some(Value::Bool(false)) => "is signed out",
        _ => "couldn't be checked",
    };
    let name = switching::label(&v, a, id);
    match usage::usable(data, a.name(), "") {
        Some(false) => Err(format!(
            "{name} {why}, and this computer's login is signed out. Sign in to start this chat."
        )),
        _ => Ok(Some(format!(
            "{name} {why}, so this chat started on this computer's login."
        ))),
    }
}

/// The thread's one note of why, once its host is up; the chat starts without it if it fails.
pub(crate) fn tell(data: &Path, id: &str, why: Option<String>) {
    if let Some(text) = why {
        let note = json!({"event": "account", "text": text});
        let _ = crate::owner::call(data, id, json!({"op": "note", "data": note}));
    }
}

/// What Home's agent check runs as: the account new sessions start on [D2082], so the models offered
/// are the ones a session there gets; the computer's login ("") otherwise.
pub(crate) fn check_as(data: &Path, a: &dyn Adapter, cwd: &Path) -> (String, Spec) {
    let spec = Spec {
        backend: a.name().into(),
        ..Default::default()
    };
    match starting(data, spec).starts_on {
        Some(id) => (
            id.clone(),
            on_account(a, data, &id, &cwd.display().to_string()),
        ),
        None => (String::new(), Spec::default()),
    }
}
