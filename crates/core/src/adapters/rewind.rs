//! What rewinding asks of an agent's CLI [D378, D384]: cutting its conversation at a boundary it
//! can name exactly. Files are Brigadier's own snapshots, the same for every agent.

use crate::fold::Boundary;
use serde::{Deserialize, Serialize};

/// Where to cut: the last turn kept (none cuts back to before the first), and the first dropped.
pub struct Cut<'a> {
    pub kept: Option<&'a Boundary>,
    pub dropped: &'a Boundary,
}

/// The conversation after a cut: a new one (`fresh`), another id (`moved`), or the entry the next
/// launch must resume at (`pin`). All empty: the same conversation, already cut.
#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Rewound {
    #[serde(default)]
    pub fresh: bool,
    #[serde(default)]
    pub moved: Option<String>,
    #[serde(default)]
    pub pin: Option<String>,
    /// Turns `moved` already holds, kept from the original, so the next turn counts after them.
    #[serde(default)]
    pub turns: u64,
}

/// Why a cut didn't finish: proof nothing happened, or no way to tell [D54, D300].
pub enum Failed {
    Refused(String),
    Uncertain(String),
}

/// What became of a cut whose outcome wasn't heard.
pub enum Landing {
    Applied(Rewound),
    NotApplied,
    Unknown(String),
}
