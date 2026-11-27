//! A retry keeps its previous attempt's sender, even after that attempt was rewound (O53).

use brigadier_core::{self as core, Spec, message::Message};
use serde_json::json;
use std::io;
use std::path::Path;

/// The message's sender; a worker's brief, or its retry, is marked in its parts, so it stays a
/// place to rewind to and try again as the user's was (O72).
pub(super) fn of(
    data: &Path,
    spec: &Spec,
    cid: &str,
    retry: Option<&str>,
    msg: &mut Message,
) -> io::Result<String> {
    if let Some(retry) = retry {
        let mut from = None;
        // Read the raw history: the failed attempt may no longer be in the active thread.
        core::read(&spec.dir, |item| {
            if item["kind"] == "input" && item["cid"] == retry && item["control"].is_null() {
                from = (item["origin"].as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| (s.to_string(), item["parts"]["brief"] == true));
            }
        })?;
        let (from, brief) = from.ok_or_else(|| {
            io::Error::other("The message being retried was not found in this session.")
        })?;
        if brief {
            mark(msg);
        }
        return Ok(from);
    }
    // A held or mockup worker's first brief belongs to its lead, regardless of its report list.
    let lead = crate::workers::link(data, &spec.id).and_then(|l| {
        crate::workers::record(data, &l.parent, &spec.id)
            .filter(|r| r.cid == cid)
            .map(|_| format!("peer:{}", l.parent))
    });
    if lead.is_some() {
        mark(msg);
    }
    Ok(lead.unwrap_or_else(|| "user".into()))
}

/// Its parts keep its words beside the mark: a resend composes the agent's text from them.
fn mark(msg: &mut Message) {
    if !msg.parts["parts"].is_array() {
        msg.parts["parts"] = json!([msg.text]);
    }
    msg.parts["brief"] = true.into();
}
