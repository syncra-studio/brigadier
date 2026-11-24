//! An answer's images and files, on their way with it.

use super::{deliver, new_cid, pending, refused};
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

/// The answer's images, into the running turn just before it: no CLI's own answer carries one, and
/// an agent reads them straight after the answer that lets its turn go on. `request`: what it
/// answers, None where an agent's send waits. Refused, the answer isn't given; none, Null.
pub fn beside(data: &Path, id: &str, given: &Answers, request: Option<&str>) -> io::Result<Value> {
    if given.images.is_empty() {
        return Ok(Value::Null);
    }
    let req = with(
        json!({"cid": new_cid()}),
        &mut json!({"kind": "beside"}),
        given,
    );
    deliver(data, id, req, true, |f| {
        if !f.turns.first().is_some_and(|t| t.began) {
            return Err(refused("not_running", Value::Null));
        }
        let asked = request.map_or(Ok(&Value::Null), |r| pending(f, r))?;
        let text = given.beside(&asked["items"]);
        Ok(json!({"kind": "steer", "text": text, "images": given.images, "request": asked}))
    })
}
