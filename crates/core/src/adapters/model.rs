use serde_json::Value;

/// A model a session can pick: its id, the name people know it by, whether it runs on this
/// computer, and the effort levels its CLI reports for it, lowest first, with its default; empty
/// and None where the CLI reports none, never guessed [D74, D129].
#[derive(Default)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub local: bool,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
    /// Being retired, where its CLI's list says so [D487]: `{at, to}`, when (ms) and the model it
    /// suggests instead, each null where not said. None for a model nothing says of [D74].
    pub retiring: Option<Value>,
}

impl ModelInfo {
    /// A model known only by its id: no name of its own, no efforts reported.
    pub fn plain(id: &str, local: bool) -> Self {
        let (id, name) = (id.to_string(), id.to_string());
        Self {
            id,
            name,
            local,
            ..Self::default()
        }
    }
}
