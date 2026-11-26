//! Which branches with work that never landed a delete takes [D181]: the session's own, and a folder
//! chat's one per repository it claimed [D494]. Delete's confirm keeps them all.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Which of them go: all or none, or those in these repositories of a folder chat, "" for a session's
/// own.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(untagged)]
pub enum Chosen {
    All(bool),
    In(Vec<String>),
}

impl Chosen {
    /// As recorded; none that can't be read.
    pub fn of(v: &Value) -> Chosen {
        serde_json::from_value(v.clone()).unwrap_or(Chosen::All(false))
    }

    pub fn takes(&self, repo: &str) -> bool {
        match self {
            Chosen::All(all) => *all,
            Chosen::In(repos) => repos.iter().any(|r| r == repo),
        }
    }
}
