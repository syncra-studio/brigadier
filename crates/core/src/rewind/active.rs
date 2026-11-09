//! Reading a log with what rewinds dropped left out [D384]: the thread, search and hand-offs read
//! this; adapters' cleanup reads everything [D35].

use brigadier_frames::log::{self, Reader};
use serde_json::Value;
use std::io;
use std::path::Path;

/// Which of a log's items still stand: a rewind drops everything from its message to its note,
/// but what ran stays known, for sweeping and delete [D35].
#[derive(Default)]
pub struct Active {
    cuts: Vec<(String, u64)>,
    until: u64,
    last: u64,
}

impl Active {
    pub fn scan(dir: &Path) -> io::Result<Active> {
        let mut active = Active::default();
        let path = dir.join("log");
        if !path.exists() {
            return Ok(active);
        }
        let mut reader = Reader::open(&path, 0, 0)?;
        while let Some(frame) = reader.next_with(|k| k == log::NOTE)? {
            let v: Value = serde_json::from_slice(&frame.data).unwrap_or(Value::Null);
            if let (Some("rewound"), Some(to)) = (v["event"].as_str(), v["to"].as_str()) {
                active.cuts.push((to.into(), frame.seq));
                active.last = frame.seq;
            }
        }
        Ok(active)
    }

    pub fn keep(&mut self, seq: u64, item: &Value) -> bool {
        let kind = item["kind"].as_str().unwrap_or("");
        if kind == "input" {
            let found = self
                .cuts
                .iter()
                .filter(|(to, at)| item["cid"] == to.as_str() && *at > seq);
            self.until = found.map(|(_, at)| *at).max().unwrap_or(0).max(self.until);
        }
        seq > self.until
            || matches!(
                kind,
                "spawned" | "exited" | "stopped" | "note" | "resume_id"
            )
    }

    /// Whether this item is a rewind newer than the scan: what was read before it is stale.
    pub fn newer(&self, seq: u64, item: &Value) -> bool {
        item["kind"] == "note" && item["event"] == "rewound" && seq > self.last
    }
}

/// Every item still standing, in order.
pub fn read_active(dir: &Path, mut each: impl FnMut(&Value)) -> io::Result<()> {
    let mut active = Active::scan(dir)?;
    let mut norm = crate::norm::Norm::default();
    let mut reader = Reader::open(&dir.join("log"), 0, 0)?;
    let mut items = vec![];
    while let Some(frame) = reader.frame()? {
        norm.push(&frame, &mut items);
        for item in items.drain(..) {
            if active.keep(frame.seq, &item) {
                each(&item);
            }
        }
    }
    Ok(())
}
