//! The account's rate limits as the app-server reports them: merged as they come, passed on to
//! the usage store, and read for a limited turn's reset and credits.

use super::{State, say};
use serde_json::{Value, json};
use std::collections::HashMap;

/// Its limits as now known, passed on so the usage store keeps them [D2039].
pub(super) fn tell_limits(st: &State) {
    say(json!({"type": "brigadier.limits", "data": {"rateLimitsByLimitId": st.limits}}));
}

pub(super) fn limit_id(snap: &Value) -> String {
    snap["limitId"].as_str().unwrap_or("codex").into()
}

/// A limit update is sparse: what it leaves out or null stays as last known.
pub(super) fn merge(st: &mut State, snap: &Value) {
    let known = st.limits.entry(limit_id(snap)).or_insert_with(|| json!({}));
    for (k, v) in snap.as_object().into_iter().flatten() {
        if !v.is_null() {
            known[k.as_str()] = v.clone();
        }
    }
}

/// When the limit that was hit resets (ms): of the buckets marked as reached, or all if none is,
/// the windows used up, the latest reset among them; None when none says (proposed) [D74, D220].
pub(super) fn resets(limits: &HashMap<String, Value>) -> Option<u64> {
    let reached = limits
        .values()
        .any(|s| !s["rateLimitReachedType"].is_null());
    (limits.values())
        .filter(|s| !reached || !s["rateLimitReachedType"].is_null())
        .flat_map(|s| [&s["primary"], &s["secondary"]])
        .filter(|w| w["usedPercent"].as_i64().is_some_and(|u| u >= 100))
        .filter_map(|w| w["resetsAt"].as_u64())
        .max()
        .map(|secs| secs * 1000)
}

/// Whether Codex marks the account out of credits, which no reset lifts. Only its main bucket
/// carries the mark, read fresh once a limited turn ends. A spend cap is another value and stays a limit.
pub(super) fn out_of_credits(limits: &HashMap<String, Value>) -> bool {
    matches!(
        limits
            .get("codex")
            .and_then(|s| s["rateLimitReachedType"].as_str()),
        Some("workspace_owner_credits_depleted" | "workspace_member_credits_depleted")
    )
}
