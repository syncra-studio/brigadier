//! The session's grants as Codex's own session answers [D193, D247].

use serde_json::Value;

/// Whether this command can be allowed for the session. Codex now lists a saved rule instead of a
/// session answer for most commands, but still honours the session answer, and only that one stays
/// out of its files [D193]. A request for extra permissions gets neither, so it's asked every time.
pub(super) fn can_grant(p: &Value) -> bool {
    p["availableDecisions"].as_array().is_none_or(|d| {
        d.iter()
            .any(|o| o == "acceptForSession" || o.get("acceptWithExecpolicyAmendment").is_some())
    })
}

/// Codex's answer for a request a session grant covers, as its own session answer so it caches it
/// as well [D193, D247]. A command by its exact words and folder, as Codex keys its own cache.
pub(super) fn covered(grants: &[Value], method: &str, p: &Value) -> Option<&'static str> {
    if method == "item/commandExecution/requestApproval" && p["canGrant"] != true {
        return None;
    }
    let host = p["networkApprovalContext"]["host"].as_str();
    let hit = |g: &Value| {
        let (scope, pattern) = (&g["grant"]["scope"], g["grant"]["pattern"].as_str());
        match method {
            "item/commandExecution/requestApproval" if host.is_some() => {
                scope == "network" && pattern == host
            }
            // One `brigadier` agent command's grant covers them all, in any folder [D2026].
            "item/commandExecution/requestApproval" => {
                let agent = |c: Option<&str>| c.is_some_and(crate::agent::call);
                crate::adapters::repeat(g, &p["command"], &p["cwd"])
                    || scope == "command" && agent(pattern) && agent(p["command"].as_str())
            }
            "item/fileChange/requestApproval" => {
                let files = p["files"].as_array().filter(|f| !f.is_empty());
                let inside = |root: &str| {
                    files.is_some_and(|f| {
                        f.iter().filter_map(Value::as_str).all(|f| {
                            f.strip_prefix(root)
                                .is_some_and(|rest| rest.starts_with('/'))
                        })
                    })
                };
                scope == "edits" && pattern.is_some_and(inside)
            }
            _ => false,
        }
    };
    grants.iter().any(hit).then_some("acceptForSession")
}
