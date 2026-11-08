//! Codex's folder trust: `[projects."<root>"] trust_level` in `$CODEX_HOME/config.toml`, which
//! it writes with no lock (codex-rs `core/src/config/edit.rs`). Its app-server saves "trusted"
//! on its own where no entry exists, so an untrusted answer is written too [D182].

use crate::trust::Trust;

pub const TRUST: Trust = Trust {
    default: ".codex/config.toml",
    file: "config.toml",
    toml: true,
    table: "projects",
    key: "trust_level",
    trusted: "\"trusted\"",
    untrusted: Some("\"untrusted\""),
    lock: None,
};
