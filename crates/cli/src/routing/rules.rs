//! The rules' checks [D338, D341, D376]: a model a "never use" rule bars, an effort above a
//! "never above" cap, at every launch, in the pickers and for a worker's entries.

use super::*;

/// Every launch's check, as `Spec::rules` [D376, D388 Q9 Q10, D392 P9]: a model a "never use" rule
/// bars is refused in the rule's words, so the user picks another; an effort above a cap runs at
/// the cap. Not a worker's whole `allowed`: a session keeps a model hidden or no longer listed.
pub(crate) fn launch(
    data: &Path,
    cwd: &str,
    agent: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<core::Ruled, String> {
    let rules = rules_of(data);
    let touched = (rules.iter())
        .any(|r| r["agent"] == agent || (r["never"] == "above" && r["agent"].is_null()));
    if !touched {
        return Ok(core::Ruled::default());
    }
    // The agent's whole listed catalogue, hidden models too: the pickers' is filtered [D2082]. The
    // launch folder's check (a project's own models), else the home folder's, as the pickers read.
    let listed_in = |cwd: &str| -> Vec<Value> {
        let mut args = vec!["agents".to_string(), "--cached".into()];
        if !cwd.is_empty() {
            args.extend(["--cwd".into(), cwd.into()]);
        }
        let check = crate::setup::run(data, &args).unwrap_or_default();
        (check["agents"].as_array().into_iter().flatten())
            .filter(|c| c["name"] == agent)
            .flat_map(|c| c["models"].as_array().into_iter().flatten())
            .cloned()
            .collect()
    };
    let mut listed = listed_in(cwd);
    if listed.is_empty() {
        listed = listed_in("");
    }
    // Unpicked, it runs its CLI's default model.
    let id = model
        .or_else(|| (listed.iter().find(|m| m["default"] == true)).and_then(|m| m["id"].as_str()));
    let m = id.and_then(|id| listed.iter().find(|m| m["id"] == id));
    if let Some(id) = id.filter(|id| barred(&rules, agent, id)) {
        let name = m.and_then(|m| m["name"].as_str()).unwrap_or(id);
        return Err(format!("{name} is barred by your rule; pick another model"));
    }
    let effort = m
        .and_then(|m| effort_of(&rules, agent, m, effort, false).ok())
        .filter(|(_, note)| note.is_some())
        .and_then(|(e, _)| e);
    let ids = || listed.iter().filter_map(|m| m["id"].as_str());
    // No older version: one named pins its family's alias to it ("haiku" ran Haiku 4.5) [D376].
    let mut models: Vec<String> = (listed.iter().filter(|m| m["legacy"] != true))
        .filter_map(|m| m["id"].as_str())
        .filter(|x| !barred(&rules, agent, x) && Some(*x) != id)
        .map(String::from)
        .collect();
    // Its own model stays, listed or not.
    models.extend(id.map(String::from));
    let models = ids().any(|x| barred(&rules, agent, x)).then_some(models);
    Ok(core::Ruled {
        effort,
        touched,
        models,
    })
}

/// The pickers' models: none a rule bars, no effort above a cap [D376].
pub(crate) fn picks(data: &Path, groups: &mut [Value]) {
    let rules = rules_of(data);
    for g in groups {
        let agent = str_of(g, "provider").to_string();
        let Some(ms) = g["models"].as_array_mut() else {
            continue;
        };
        ms.retain(|m| !barred(&rules, &agent, str_of(m, "id")));
        for m in ms {
            let efforts: Vec<String> = (m["efforts"].as_array().into_iter().flatten())
                .filter_map(|e| e.as_str().map(String::from))
                .collect();
            let refs: Vec<&str> = efforts.iter().map(String::as_str).collect();
            let Some(cap) = cap(&rules, &agent, &refs) else {
                continue;
            };
            m["efforts"] = json!(efforts[..=cap]);
            if (m["default_effort"].as_str())
                .is_some_and(|d| !efforts[..=cap].iter().any(|e| e == d))
            {
                m["default_effort"] = efforts[cap].clone().into();
            }
        }
    }
}

pub(super) fn barred(rules: &[Value], agent: &str, id: &str) -> bool {
    (rules.iter()).any(|r| r["never"] == "model" && r["agent"] == agent && r["model"] == id)
}

/// The effort words agents share, low to high: for a model whose own list lacks a rule's.
const EFFORTS: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/// The highest effort `agent`'s model may run at by the "never above" rules, by its own list;
/// one without the rule's effort, its highest below it by the shared words ("never above high"
/// leaves none, low, medium of none, low, medium, xhigh) [D376, D392 P9].
pub(super) fn cap(rules: &[Value], agent: &str, efforts: &[&str]) -> Option<usize> {
    let rank = |e: &str| EFFORTS.iter().position(|x| *x == e);
    (rules.iter())
        .filter(|r| r["never"] == "above" && (r["agent"].is_null() || r["agent"] == agent))
        .filter_map(|r| {
            let top = str_of(r, "effort");
            (efforts.iter().position(|e| *e == top)).or_else(|| {
                let top = rank(top)?;
                efforts
                    .iter()
                    .rposition(|e| rank(e).is_some_and(|k| k < top))
            })
        })
        .min()
}

/// The model of an entry the user allows: listed, not hidden, not barred, its agent on [D338,
/// D2079, D2082]; or why not.
pub(super) fn allowed<'a>(
    data: &Path,
    groups: &'a [Value],
    rules: &[Value],
    agent: &str,
    id: &str,
) -> Result<&'a Value, String> {
    if !groups.iter().any(|g| g["provider"] == agent) {
        return Err(format!(
            "{agent:?} isn't an agent you may use. `brigadier models` lists them."
        ));
    }
    if settings::models_off(data, agent).iter().any(|m| m == id) {
        return Err(format!("{id} is hidden in Settings, so no worker runs it."));
    }
    let m = model_of(groups, agent, id).ok_or_else(|| {
        format!("{id:?} isn't a model of {agent} you may use. `brigadier models` lists them.")
    })?;
    if barred(rules, agent, id) {
        return Err(format!("A rule in Settings › Routing says never use {id}."));
    }
    Ok(m)
}

/// The effort an entry runs at: its own (or `--effort`), else the model's default; one above a
/// rule runs at the highest the rule allows, with a note, or is refused when asked for outright
/// (`strict`) [D338] (proposed).
pub(super) fn effort_of(
    rules: &[Value],
    agent: &str,
    m: &Value,
    want: Option<&str>,
    strict: bool,
) -> Result<(Option<String>, Option<String>), String> {
    let id = str_of(m, "id");
    let efforts: Vec<&str> = (m["efforts"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .collect();
    if let Some(w) = want.filter(|w| !efforts.contains(w)) {
        return Err(format!(
            "{id} has no effort {w:?}. `brigadier models` lists its efforts."
        ));
    }
    let now = want.or(m["default_effort"].as_str());
    let at = now.and_then(|e| efforts.iter().position(|x| *x == e));
    match (cap(rules, agent, &efforts), at) {
        (Some(cap), Some(at)) if at > cap && strict => Err(format!(
            "A rule in Settings › Routing says never above {}, so {id} can't run at {}.",
            efforts[cap], efforts[at]
        )),
        (Some(cap), Some(at)) if at > cap => Ok((
            Some(efforts[cap].into()),
            Some(format!("{id} runs at {} by your rule", efforts[cap])),
        )),
        _ => Ok((want.map(String::from), None)),
    }
}
