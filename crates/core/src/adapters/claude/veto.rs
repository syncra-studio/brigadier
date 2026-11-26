//! The summary turn's tool block on Claude Code [repo-merge D92]: a `PreToolUse` hook on every
//! tool, Brigadier's `hook tool`, which refuses each call by exit 2 while a summary turn runs. A
//! hook that fails, times out or is missing blocks too (`onFailure: "block"`). The live proof
//! (w60) held it at Full access and over the user's allow rules, on 2.1.332.

use crate::Spec;
use serde_json::{Value, json};
use std::path::Path;

/// The first version proved.
const PROVED: &str = "2.1.332";

/// Whether this session's Claude Code is one the proof holds for: that version or later, never one
/// whose version can't be read.
pub fn vetoes(spec: &Spec) -> bool {
    let v = crate::cli_version(spec, &super::Claude);
    let newer = crate::adapters::setup::newer;
    newer(&v, "0") && !newer(PROVED, &v)
}

/// Adds the hook first among `settings`' PreToolUse hooks, on a version that vetoes. The tools
/// stay as they are, so the prompt cache holds.
pub(super) fn add(spec: &Spec, settings: &mut Value, me: &Path) {
    if !vetoes(spec) {
        return;
    }
    let me = me.display().to_string().replace('\'', r"'\''");
    let hook = json!({"matcher": "*", "hooks": [{"type": "command", "command": format!("'{me}' hook tool"), "timeout": 3, "onFailure": "block"}]});
    if let Some(hooks) = settings["hooks"]["PreToolUse"].as_array_mut() {
        hooks.insert(0, hook);
    }
}
