//! Reading a log with what rewinds dropped left out [D384]: the thread, search and hand-offs read
//! this; adapters' cleanup reads everything [D35].

use brigadier_frames::log::{self, Reader};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io;
use std::path::Path;

/// Which of a log's items still stand: a rewind drops everything from its message to its note,
/// but what ran stays known, for sweeping and delete [D35].
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Active {
    cuts: Vec<(String, u64)>,
    until: u64,
    last: u64,
    /// Where the scan stopped in the log, and that frame's sequence number.
    scanned: (u64, u64),
}

impl Active {
    pub fn scan(dir: &Path) -> io::Result<Active> {
        let mut active = Active::default();
        active.more(dir)?;
        Ok(active)
    }

    /// Reads the rewinds logged since the last scan; true when there was one.
    pub fn more(&mut self, dir: &Path) -> io::Result<bool> {
        let path = dir.join("log");
        if !path.exists() {
            return Ok(false);
        }
        let mut reader = Reader::open(&path, self.scanned.0, self.scanned.1)?;
        let mut found = false;
        while let Some(frame) = reader.next_with(|k| k == log::NOTE)? {
            let v: Value = serde_json::from_slice(&frame.data).unwrap_or(Value::Null);
            if let (Some("rewound"), Some(to)) = (v["event"].as_str(), v["to"].as_str()) {
                self.cuts.push((to.into(), frame.seq));
                self.last = frame.seq;
                found = true;
            }
        }
        self.scanned = (reader.pos, reader.seq);
        Ok(found)
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
        // A night's lines go with the turns it ran in; what else is noted happened all the same.
        seq > self.until
            || item["event"] != "overnight"
                && matches!(
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
