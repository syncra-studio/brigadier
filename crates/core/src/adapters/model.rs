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
    /// Its usage limits as its CLI reads them [D28]; None where they weren't read.
    pub usage: Option<Vec<Limit>>,
}

/// One usage limit: its name ("5-hour", "Weekly · Opus"), the whole percent used and when it
/// resets (Unix ms), where said.
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Clone)]
pub struct Limit {
    pub name: String,
    pub used: u32,
    pub resets: Option<u64>,
    /// The window's length, where its CLI says.
    #[serde(default)]
    pub minutes: Option<u64>,
    /// The ids of the models it meters, from its CLI's own list; None for every model [D43].
    #[serde(default)]
    pub models: Option<Vec<String>>,
    /// Its place: the shortest window first, one that meters a single model after the one for all.
    #[serde(skip)]
    pub order: (u64, bool),
}

impl Limit {
    pub fn new(
        name: String,
        used: f64,
        resets: Option<u64>,
        minutes: Option<u64>,
        scoped: bool,
    ) -> Self {
        let used = used.clamp(0.0, 100.0).round() as u32;
        let order = (minutes.unwrap_or(u64::MAX), scoped);
        Self {
            name,
            used,
            resets,
            minutes,
            models: None,
            order,
        }
    }

    /// In their places, one of each name.
    pub fn ordered(mut limits: Vec<Limit>) -> Vec<Limit> {
        limits.sort_by_key(|l| l.order);
        limits.dedup_by(|a, b| a.name == b.name);
        limits
    }
}

/// An RFC 3339 time ("2026-11-11T13:49:58Z", "…T13:49:58.120+02:00") as Unix ms.
pub fn iso_ms(at: &str) -> Option<u64> {
    let (date, rest) = at.split_once('T')?;
    let (time, zone) = rest.split_at(rest.find(['Z', '+', '-']).unwrap_or(rest.len()));
    let n = |p: &str| p.parse::<i64>().ok();
    let mut d = date.split('-').map(n);
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let (hms, fraction) = time.split_once('.').unwrap_or((time, ""));
    let mut t = hms.split(':').map(n);
    let (h, min, sec) = (t.next()??, t.next()??, t.next().unwrap_or(Some(0))?);
    let millis = n(&format!("{fraction:0<3}")[..3])?;
    let offset = match zone {
        "" | "Z" => 0,
        _ => {
            let (hh, mm) = zone[1..].split_once(':').unwrap_or((&zone[1..], "0"));
            (n(hh)? * 60 + n(mm)?) * if zone.starts_with('-') { -1 } else { 1 }
        }
    };
    // Days from 1970-01-01, Howard Hinnant's days_from_civil.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    u64::try_from((((days * 24 + h) * 60 + min - offset) * 60 + sec) * 1000 + millis).ok()
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
    /// Its context window in tokens, where its CLI's list says [D113].
    pub window: Option<u64>,
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
