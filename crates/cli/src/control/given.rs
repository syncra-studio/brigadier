//! An answer's images and files, on their way with it.

use super::{deliver, new_cid, refused};
use brigadier_core::message::answers::Answers;
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// `req` with `control` and the answer's files, in the log beside its words.
pub(super) fn with(mut req: Value, control: &mut Value, given: &Answers) -> Value {
    if given.filed() {
        control["files"] = given.files.clone().into();
        req["parts"] = given.parts.clone();
    }
    req["control"] = control.clone();
    req
}

/// An answer to `asked` as its adapter takes it: no CLI's own answer carries an image, so they go
/// as the steer `beside` it.
pub(super) fn told(control: &Value, asked: &Value, given: &Answers) -> Value {
    let mut msg = control.clone();
    msg["request"] = asked.clone();
    if let Some(beside) = given.beside(&asked["items"]) {
        msg["beside"] = beside.into();
        msg["images"] = json!(given.images);
    }
    msg
}

/// The images of an answer an agent's wait got, into its running turn after it. Not taken, the
/// answer still names each one's file.
pub fn beside(data: &Path, id: &str, given: &Answers) -> io::Result<()> {
    let mut control = json!({"kind": "beside"});
    let req = with(json!({"cid": new_cid()}), &mut control, given);
    let Some(text) = given.beside(&Value::Null) else {
        return Ok(());
    };
    let reply = deliver(data, id, req, false, |f| match f.turns.first() {
        Some(t) if t.began => Ok(json!({"kind": "steer", "text": text, "images": given.images})),
        _ => Err(refused("not_running", Value::Null)),
    })?;
    if reply["ok"] != true {
        eprintln!("{id} took no images with the answer: {reply}");
    }
    Ok(())
}
