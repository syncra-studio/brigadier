//! A model its agent lists under a new id, or replaced by a newer one of its family: what the user
//! saved under the old id holds for the new one, in their jobs, rules and images model. Worked out
//! from the agent's own list; no model is named here.

use super::*;

/// The id `agent` lists now for a model it no longer lists as `id`: the one listed under the name it
/// last had, else its family's one listed model, newer than it was; an id may be the family's own name.
/// Never one the user hid, which is still listed, or one of another provider's ("openai/gpt").
pub(super) fn renamed(saved: &Value, groups: &[Value], agent: &str, id: &str) -> Option<String> {
    let g = groups.iter().find(|g| g["provider"] == agent)?;
    let current = || (g["models"].as_array().into_iter().flatten()).filter(|m| m["legacy"] != true);
    let hidden = (g["hidden"].as_array().into_iter().flatten()).any(|h| h == id);
    if hidden || current().next().is_none() || model_of(groups, agent, id).is_some() {
        return None;
    }
    let was = saved["seen"][agent]["names"][id].as_str().unwrap_or(id);
    let last = offers::family(was);
    let of = |id: &str| id.rsplit_once('/').map(|(p, _)| p.to_string());
    let family = |m: &&Value| {
        offers::family(str_of(m, "name"))
            .is_some_and(|f| f.0 == id || last.as_ref().is_some_and(|l| l.0 == f.0 && l.1 < f.1))
    };
    let here = || current().filter(|m| of(str_of(m, "id")) == of(id));
    let mut found: Vec<&Value> = here().filter(|m| m["name"] == was).collect();
    if found.is_empty() {
        found = here().filter(family).collect();
    }
    match found[..] {
        [one] => Some(str_of(one, "id").into()),
        _ => None,
    }
}

/// What's saved, each renamed model under its new id: what every check and the page read.
pub(super) fn settled(data: &Path, groups: &[Value]) -> Value {
    let was = read(&data.join(FILE));
    let mut saved = was.clone();
    if saved["jobs"].is_array() {
        saved["jobs"] = jobs::all(&was, groups).into();
    }
    let rename = |x: &mut Value| {
        let id = renamed(&was, groups, str_of(x, "agent"), str_of(x, "model"));
        id.inspect(|id| x["model"] = id.as_str().into());
    };
    if let Some(rules) = saved.get_mut("rules").and_then(Value::as_array_mut) {
        (rules.iter_mut().filter(|r| r["never"] == "model")).for_each(rename);
    }
    (saved
        .get_mut("images")
        .filter(|i| i.is_object())
        .into_iter())
    .for_each(rename);
    saved
}
