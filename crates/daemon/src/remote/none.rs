//! Remote access isn't on Windows yet: no gateway, no phone, nothing kept awake for one.

use brigadier_frames::wire::Stream;
use serde_json::{Value, json};
use std::path::Path;

/// Never made here: no phone signs in.
pub(crate) struct Device;

type Serve = dyn Fn(Stream, u64, Device) + Send + Sync;
type Row = dyn Fn(&str) -> Option<Value> + Send + Sync;

#[expect(dead_code, reason = "no phone is served on Windows")]
pub(super) struct Host {
    pub(super) serve: Box<Serve>,
    pub(super) row: Box<Row>,
    pub(super) project: Box<dyn Fn(&str) -> bool + Send + Sync>,
}

pub(super) fn host(_host: Host) {}

pub(super) fn enabled() -> bool {
    false
}

#[derive(Default)]
pub(super) struct Remote {
    _none: (),
}

impl Remote {
    pub(super) fn pass(&mut self, _data: &Path) {}
}

pub(super) fn awake(_data: &Path) -> bool {
    false
}

pub(super) fn under_gateway(_pid: i32) -> bool {
    false
}

pub(super) fn cli(_data: &Path, _args: &[String]) -> Value {
    json!({"ok": false, "error": "Remote access isn't on Windows yet."})
}
