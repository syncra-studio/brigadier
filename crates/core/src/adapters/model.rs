use serde_json::Value;

/// What a status check found [D45]: its version, whether it's signed in and how and who, each login
/// of a CLI that keeps several in one home, and the models a session can pick. Never a credential.
#[derive(Default)]
pub struct Check {
    pub version: String,
    pub signed_in: Option<bool>,
    pub how: String,
    pub who: Who,
    pub logins: Vec<String>,
    pub models: Vec<ModelInfo>,
}

/// Who signed in, where its CLI says: email, plan ("max") and organization [D24].
#[derive(Default)]
pub struct Who {
    pub email: Option<String>,
    pub plan: Option<String>,
    pub org: Option<String>,
}

impl Who {
    /// From a CLI's answer, by the names of its email, plan and organization fields.
    pub fn read(v: &Value, [email, plan, org]: [&str; 3]) -> Who {
        let field = |k: &str| v[k].as_str().filter(|s| !s.is_empty()).map(String::from);
        Who {
            email: field(email),
            plan: field(plan),
            org: field(org),
        }
    }
}

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
    /// Whether it takes images, where its CLI's list says; None where nothing says [D2022 #14].
    pub images: Option<bool>,
    /// What its fast tier offers ("1.5x speed, increased usage"), where its CLI's list has one;
    /// the picker's Speed picks it, and its adapter runs it.
    pub fast: Option<String>,
    /// An older model its CLI still offers beside a newer one: pickers tuck it under Older models.
    pub legacy: bool,
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

/// Marks legacy each model with a newer namesake ("Opus 4.8" beside "Opus 5.5", "X-6-Sol" beside
/// "X-6.1-Sol"); a name without a version is left alone. Then names apart models that share a
/// name: the part of the id before its `/`, else the whole id, in brackets.
pub fn mark_superseded(models: &mut [ModelInfo]) {
    let named: Vec<_> = models.iter().map(|m| versioned(&m.name)).collect();
    for (model, own) in models.iter_mut().zip(&named) {
        if let Some((family, version)) = own
            && (named.iter().flatten()).any(|(other, newer)| other == family && newer > version)
        {
            model.legacy = true;
        }
    }
    let source = |id: &str| id.split_once('/').map_or(id, |(s, _)| s).to_string();
    let names: Vec<(String, String)> = models
        .iter()
        .map(|m| (m.name.clone(), source(&m.id)))
        .collect();
    for model in models.iter_mut() {
        let namesakes: Vec<&String> = (names.iter())
            .filter(|(name, _)| *name == model.name)
            .map(|(_, s)| s)
            .collect();
        if namesakes.len() < 2 {
            continue;
        }
        let own = source(&model.id);
        let shown = match namesakes.iter().filter(|o| ***o == own).count() > 1 {
            true => model.id.clone(),
            false => own,
        };
        model.name = format!("{} ({shown})", model.name);
    }
}

/// A model name's family (the name with its version cut out) and version: "Opus 5.5 (1M)" →
/// ("Opus  (1M)", [5, 5]), "X-6-Sol" → ("X--Sol", [6]).
pub fn versioned(name: &str) -> Option<(String, Vec<u32>)> {
    let mut start = 0;
    for token in name.split([' ', '-']) {
        let version: Option<Vec<u32>> = token.split('.').map(|p| p.parse().ok()).collect();
        if let Some(version) = version {
            return Some((
                format!("{}{}", &name[..start], &name[start + token.len()..]),
                version,
            ));
        }
        start += token.len() + 1;
    }
    None
}
