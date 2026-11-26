//! What each job would run now, for Settings › Routing: each model's quota or why it can't run, on
//! the account new work starts on. Only shown: nothing is reserved and no CLI is asked.

use super::place::place;
use super::*;

/// "Weekly 43%, resets 14:05", "Full until 15:10", "Barred by your rule", and whether it can't run.
fn state(data: &Path, groups: &[Value], rules: &[Value], v: &Value, e: &Value) -> (Value, bool) {
    let (agent, id) = (str_of(e, "agent"), str_of(e, "model"));
    let Some(a) = (allowed(data, groups, rules, agent, id).ok()).and_then(|_| adapters::get(agent))
    else {
        let why = unusable(data, groups, rules, agent, id).1;
        let why = why.split(['(', ')']).nth(1).unwrap_or(why);
        return (capital(why).into(), true);
    };
    let base = v["use"][agent].as_str().unwrap_or("");
    match place(data, a, id, base, "", "", "\0", false) {
        Ok((account, _)) => {
            // The shortest window with a fresh sample that meters it.
            let meters =
                |w: &usage::Window| (w.models.as_ref()).is_none_or(|m| m.iter().any(|x| x == id));
            let found = (usage::of(data, agent, &account).into_iter())
                .filter(|w| w.used.is_some() && meters(w))
                .min_by_key(|w| w.minutes.unwrap_or(u64::MAX));
            let text = found.map(|w| {
                let resets = w
                    .resets
                    .map_or(String::new(), |at| format!(", resets {}", clock(at)));
                format!("{} {}%{resets}", w.name, w.used.unwrap_or(0))
            });
            (json!(text), false)
        }
        Err(Some(at)) => (format!("Full until {}", clock(at)).into(), true),
        Err(None) => ("Full".into(), true),
    }
}

/// Each job by its name: `runs`, the line its row shows, and `entries`, by "agent/model".
pub(super) fn now(data: &Path, groups: &[Value], t: &Value) -> Value {
    let v = accounts::load(data);
    let rules = t["rules"].as_array().cloned().unwrap_or_default();
    let mut out = serde_json::Map::new();
    for j in t["jobs"].as_array().into_iter().flatten() {
        let (mut entries, mut first, mut runs) = (serde_json::Map::new(), None, None);
        for e in j["entries"].as_array().into_iter().flatten() {
            let (agent, id) = (str_of(e, "agent"), str_of(e, "model"));
            let m = model_of(groups, agent, id);
            let name = m.and_then(|m| m["name"].as_str()).unwrap_or(id);
            let (text, off) = state(data, groups, &rules, &v, e);
            if !off && runs.is_none() {
                let effort = m.and_then(|m| effort_of(&rules, agent, m, e["effort"].as_str()).ok());
                let effort = (effort.and_then(|x| x.0))
                    .or(m.and_then(|m| m["default_effort"].as_str().map(String::from)))
                    .map_or(String::new(), |x| format!(" · {}", level(&x)));
                runs = Some(format!("{name}{effort}"));
            }
            if off && runs.is_none() && first.is_none() {
                first = Some(match text.as_str().and_then(|t| t.strip_prefix("Full")) {
                    Some(until) => format!("{name} is full{until}"),
                    None => format!("{name} can't run"),
                });
            }
            entries.insert(format!("{agent}/{id}"), json!({"text": text, "off": off}));
        }
        let review = j["name"] == jobs::REVIEW;
        let runs = match (runs, first) {
            (Some(_), _) if review => "Runs the first not on the author's agent".into(),
            (Some(r), None) => format!("Runs {r}"),
            (Some(r), Some(passed)) => format!("{passed}, runs {r}"),
            (None, _) if entries.is_empty() => "No model yet".into(),
            (None, _) => "Nothing here can run now".to_string(),
        };
        out.insert(
            str_of(j, "name").into(),
            json!({"runs": runs, "entries": entries}),
        );
    }
    out.into()
}
