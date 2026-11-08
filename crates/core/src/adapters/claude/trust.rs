//! Claude Code's folder trust: `projects["<root>"].hasTrustDialogAccepted` in `~/.claude.json`,
//! or `.claude.json` in `$CLAUDE_CONFIG_DIR` (the Agent SDK's `scripts/trust_workspace.py`).
//! It writes that file holding the folder `.claude.json.lock` (seen with 2.1.319), so Brigadier
//! takes it too. It has no "untrusted" value: a missing one asks.

use crate::trust::Trust;

pub const TRUST: Trust = Trust {
    default: ".claude.json",
    file: ".claude.json",
    toml: false,
    table: "projects",
    key: "hasTrustDialogAccepted",
    trusted: "true",
    untrusted: None,
    lock: Some(".lock"),
};
