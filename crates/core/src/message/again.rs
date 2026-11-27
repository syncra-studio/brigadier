//! A logged message sent again: a Resume, a resend, a switch's replay.

use super::Message;
use crate::Spec;
use serde_json::{Value, json};

/// A message sent again as it was first sent: its own parts, its words and marks with them (a
/// worker's brief, O72), its files already in the session's folder, still naming the steers a
/// Recover gave back with it [D66]. Every replay of a logged message goes through here.
pub fn again(spec: &Spec, text: &str, parts: &Value) -> Message {
    let mut own = parts.clone();
    if let Some(p) = own.as_object_mut() {
        p.remove("back");
        if p.is_empty() {
            own = Value::Null;
        }
    }
    let mut msg = super::compose(spec, text, own, None).unwrap_or_else(|_| Message::plain(text));
    if parts["back"].is_array() {
        if !msg.parts.is_object() {
            msg.parts = json!({});
        }
        msg.parts["back"] = parts["back"].clone();
    }
    msg
}
