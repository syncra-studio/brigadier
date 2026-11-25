//! A session's small files, as its row shows them.

use brigadier_core as core;
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

/// Marks published by creating or renaming entries in the session folder.
#[derive(Default)]
pub(super) struct Marks {
    /// The folder's modification time (ms) these were read at.
    pub(super) at: u64,
    pub(super) title: Option<String>,
    pub(super) pinned: Option<u64>,
    /// Its labels' names (`labels`), in the order given [D3101, D3103].
    pub(super) labels: Value,
    pub(super) seen: u64,
    /// When its mockup last had news for the user, a round drawn or its pick built (`news`) [D560].
    pub(super) news: u64,
    /// When it was archived, and an archive, restore or delete under way or left unfinished [D180].
    pub(super) archived: Option<u64>,
    pub(super) lifecycle: Value,
    /// Archived with its Brigade, so the Brigade's restore brings it back [D3111].
    pub(super) with: bool,
    /// The follow-up queue (`queue.json`), null when empty.
    pub(super) queue: Value,
    /// Its PRs as the last reads kept them (`prs.json`, its claims' too), and the sidebar chip they make [D1018].
    pub(super) prs: Value,
    pub(super) pr: Value,
    pub(super) overnight: core::overnight::Overnight,
}

impl Marks {
    pub(super) fn read(dir: &Path, at: u64) -> Marks {
        let text = |name: &str| fs::read_to_string(dir.join(name)).ok();
        let ms = |name: &str| text(name).and_then(|s| s.trim().parse().ok());
        let (archived, lifecycle) = core::session::lifecycle(dir);
        let prs = core::host::listed(dir);
        Marks {
            at,
            title: text("title").filter(|t| !t.is_empty()),
            pinned: ms("pinned"),
            labels: text("labels")
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_else(|| json!([])),
            seen: ms("seen").unwrap_or(0),
            news: ms("news").unwrap_or(0),
            archived,
            lifecycle,
            with: core::session::went_with(dir),
            queue: crate::workers::held(dir, crate::queue::row(dir)),
            pr: core::host::chip(dir, &prs),
            prs,
            overnight: core::overnight::load(dir),
        }
    }
}
