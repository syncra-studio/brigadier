//! Working with the lid closed stays hidden off macOS [D170], Linux's too until logind's lid hold
//! is built (proposed): nothing to hold or set up.

use serde_json::{Value, json};
use std::io;
use std::path::Path;

pub fn seen(_data: &Path, _at: Option<&String>) -> io::Result<Value> {
    Ok(json!({"ok": true}))
}

pub fn status(_data: &Path) -> io::Result<Value> {
    Ok(json!({"ok": true, "lid": "unsupported"}))
}

pub fn set_up(data: &Path) -> io::Result<Value> {
    status(data)
}

pub fn wanted(_data: &Path) -> bool {
    false
}

pub fn recover(_data: &Path) {}

#[derive(Default)]
pub struct Lid {}

impl Lid {
    pub fn set(&mut self, _data: &Path, _want: bool) {}

    pub fn shown(&self, _data: &Path) -> Value {
        json!({"held": false, "warned": null, "slept": null})
    }
}
