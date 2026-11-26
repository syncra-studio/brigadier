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

/// What a new session on `spec`, a "chat" or a "worker", says when the account picked with Use,
/// checked `c`, can't take it [C36, C38]: it starts on the computer's login, which Providers shows
/// while it is signed in [D2065], and its thread says why (words proposed). With that login
/// signed out, or no Use pick and the login signed out, it doesn't start (Err, its words).
pub(crate) fn fell_back(
    data: &Path,
    spec: &Spec,
    c: Option<&Value>,
    what: &str,
) -> Result<Option<String>, String> {
    let v = load(data);
    let id = v["use"][&spec.backend].as_str().unwrap_or("");
    let a = match agent(&spec.backend) {
        Ok(a) if spec.starts_on.is_none() => a,
        _ => return Ok(None),
    };
    if id.is_empty() {
        return match login_ok(data, a) {
            true => Ok(None),
            false => Err(format!(
                "This computer's login ({}) is signed out. Sign in to start this {what}.",
                a.label()
            )),
        };
    }
    let why = match c.map(|c| &c["signed_in"]) {
        Some(Value::Bool(true)) => "can't be used for chats",
        Some(Value::Bool(false)) => "is signed out",
        _ => "couldn't be checked",
    };
    let name = switching::label(&v, a, id);
    match login_ok(data, a) {
        false => Err(format!(
            "{name} {why}, and this computer's login is signed out. Sign in to start this {what}."
        )),
        true => Ok(Some(format!(
            "{name} {why}, so this {what} started on this computer's login."
        ))),
    }
}

/// Whether the computer's login of `a` may run work [C36, D2065]: Providers shows it only while a
/// check finds it signed in, so one not known signed in is checked now (as a worker's pick does);
/// a check that failed isn't taken as signed out, nor as signed in. An agent that keeps one login isn't held to it:
/// OpenCode's free models run with no sign-in (proposed).
pub(crate) fn login_ok(data: &Path, a: &dyn Adapter) -> bool {
    let last = usage::usable(data, a.name(), "");
    if a.accounts().is_none() || last == Some(true) {
        return true;
    }
    let home = adapters::home_path("").display().to_string();
    // A check with no answer keeps the last one: signed out stays so until a check says otherwise.
    match check(a, data, "", &home)["signed_in"].as_bool() {
        Some(signed_in) => signed_in,
        None => last != Some(false),
    }
}

/// The thread's one note of why, once its host is up; the chat starts without it if it fails.
pub(crate) fn tell(data: &Path, id: &str, why: Option<String>) {
    let _ = told(data, id, why.as_deref(), "start");
}

/// The same note by its id `key`, drawn once however often it's written: a worker's start made
/// again after a restart writes it again [C38].
pub(crate) fn told(data: &Path, id: &str, why: Option<&str>, key: &str) -> std::io::Result<()> {
    let Some(text) = why else {
        return Ok(());
    };
    let note = json!({"event": "account", "text": text, "id": key});
    crate::owner::call(data, id, json!({"op": "note", "data": note})).map(drop)
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
