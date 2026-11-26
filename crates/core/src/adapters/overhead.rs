//! What each agent's CLI adds to a fresh conversation by itself, at its least: its own system
//! prompt and tools, the first reading of a one-word input in a folder with no instruction files,
//! as the build's live proof read them [repo-merge D94; design rev 3 §2.6]. Kept in one place:
//! each adapter's own file is at its line limit.

/// The floor for `backend`'s CLI, in tokens; the fake's is the drill's.
pub fn floor(backend: &str) -> u64 {
    match backend {
        "claude" => 22_759,
        "codex" => 18_862,
        "opencode" => 6_700,
        _ => 20_000,
    }
}
