//! A retry keeps its previous attempt's sender, even after that attempt was rewound (O53).

use brigadier_core::{self as core, Spec};
use std::io;
use std::path::Path;

pub(super) fn of(data: &Path, spec: &Spec, cid: &str, retry: Option<&str>) -> io::Result<String> {
    if let Some(retry) = retry {
        let mut from = None;
        // Read the raw history: the failed attempt may no longer be in the active thread.
        core::read(&spec.dir, |item| {
            if item["kind"] == "input" && item["cid"] == retry && item["control"].is_null() {
                from = item["origin"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(String::from);
            }
        })?;
        return from.ok_or_else(|| {
            io::Error::other("The message being retried was not found in this session.")
        });
    }
    // A held or mockup worker's first brief belongs to its lead, regardless of its report list.
    Ok(crate::workers::link(data, &spec.id)
        .and_then(|l| {
            crate::workers::record(data, &l.parent, &spec.id)
                .filter(|r| r.cid == cid)
                .map(|_| format!("peer:{}", l.parent))
        })
        .unwrap_or_else(|| "user".into()))
}
