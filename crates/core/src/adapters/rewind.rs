//! What rewinding asks of an agent's CLI [D378, D384]: cutting its conversation at a boundary it
//! can name exactly. Files are Brigadier's own snapshots, the same for every agent.

use crate::Spec;
use crate::fold::Boundary;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;

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

/// A fork's own conversation [D1063]: its id, and the turns it already holds from the original.
pub struct Forked {
    pub conv: String,
    pub turns: u64,
}

/// An agent's own fork [D1063, D1089], keyed by the forked conversation (`at.conv`) and run with
/// the source's spec. It takes no model: each adapter sends the session's own on every turn [D1081].
pub trait Fork {
    /// A new conversation holding `at.conv` up to turn `at`, for a fork working in `cwd`, that
    /// outlives the source's delete; `next` is the turn after it. Refused: the hand-off [D90].
    /// `at.conv` itself back: the fork's first launch makes it, resuming that with a fork [D1089].
    fn fork(
        &self,
        spec: &Spec,
        at: &Boundary,
        next: Option<&Boundary>,
        cwd: &Path,
    ) -> Result<Forked, Failed>;
    /// The forks `conv` has now, before one is asked; None: they can't be told, so none is asked.
    fn forks(&self, spec: &Spec, conv: &str) -> Option<Vec<String>>;
    /// Removes a fork of `conv` never heard about: one not in `before`, owned by no session [D204].
    fn unfork(
        &self,
        spec: &Spec,
        conv: &str,
        before: &[String],
        owned: &BTreeSet<String>,
    ) -> Result<(), String>;
}
