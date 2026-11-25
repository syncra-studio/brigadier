//! The user's jobs [D378, D383, D387, D388]: each a name, a "use this for" line its agents read,
//! and an ordered list of agent · model · effort. Seeds from each adapter until the first save
//! [D392 P1]; saved Best, Standard and Quick rows carried over as jobs [D388 Q4, D392 P3].

use super::*;

/// The fixed job reviews run on: reordered and edited, never renamed or deleted [D385].
pub(crate) const REVIEW: &str = "Review";

/// The default jobs and their lines; the entries are each adapter's own [D392 P1].
const SEEDED: [(&str, &str); 6] = [
    ("Write code", "Writing or changing code, with its tests."),
    (
        "Look into the codebase",
        "Reading and analysing code without changing it: tracing, audits, explaining how something works. Not reviews.",
    ),
    (
        "Research the web",
        "Finding and reading sources on the web, and summing them up with links.",
    ),
    (
        "Plan and orchestrate",
        "Planning or designing a change, splitting it into jobs and leading the workers.",
    ),
    (
        "Quick actions",
        "Fast, small steps: computer use, a lookup, a one-line edit.",
    ),
    (REVIEW, "Adversarial reviews: try to break code or a plan."),
];

/// Saved rows, by their key, become jobs of these names and lines, in this order [D388 Q4].
const CARRIED: [(&str, &str, &str); 3] = [
    ("best", "Best", "Hard problems, plans and reviews."),
    ("standard", "Standard", "Most work."),
    ("quick", "Quick", "Look-ups and small edits."),
];

/// Limits on the list [D388 Q14].
const MOST: usize = 12;
const NAME: usize = 40;
const LINE: usize = 160;

/// `agent`'s default model at its default effort, or its first listed: a seed job left empty's,
/// and `--agent`'s where its job has none on it.
pub(super) fn default_of(groups: &[Value], agent: Option<&str>) -> Option<Value> {
    let g = (groups.iter())
        .filter(|g| agent.is_none_or(|a| g["provider"] == a))
        .find(|g| g["models"].as_array().is_some_and(|m| !m.is_empty()))?;
    let ms = g["models"].as_array()?;
    let m = ms.iter().find(|m| m["default"] == true).or(ms.first())?;
    Some(json!({"agent": g["provider"], "model": m["id"], "effort": null}))
}

/// The default jobs: each adapter's seeds its CLI lists, in adapter order; an effort its model
/// lacks runs at the model's default.
fn seeds(groups: &[Value]) -> Vec<Value> {
    (SEEDED.iter())
        .map(|(name, line)| {
            let mut entries: Vec<Value> = (adapters::all().into_iter())
                .flat_map(|a| a.seeds().iter().map(move |s| (a.name(), s)))
                .filter(|(_, (job, ..))| job == name)
                .filter_map(|(a, (_, id, effort))| {
                    let m = model_of(groups, a, id)?;
                    let has =
                        |e: &&str| (m["efforts"].as_array().into_iter().flatten()).any(|x| x == e);
                    Some(json!({"agent": a, "model": id, "effort": effort.filter(has)}))
                })
                .collect();
            if entries.is_empty() {
                entries.extend(default_of(groups, None));
            }
            json!({"name": name, "for": line, "entries": entries})
        })
        .collect()
}

/// The id `agent` lists now for a model it no longer lists as `id`: the one listed under the name it
/// last had, else, an id that is a family's own name ("fable"), that family's one listed model.
pub(super) fn renamed(saved: &Value, groups: &[Value], agent: &str, id: &str) -> Option<String> {
    let g = groups.iter().find(|g| g["provider"] == agent)?;
    let current = || (g["models"].as_array().into_iter().flatten()).filter(|m| m["legacy"] != true);
    if current().next().is_none() || model_of(groups, agent, id).is_some() {
        return None;
    }
    let was = saved["seen"][agent]["names"][id].as_str();
    let family = |m: &&Value| super::offers::family(str_of(m, "name")).is_some_and(|f| f.0 == id);
    let mut found = match was {
        Some(name) => current().filter(|m| m["name"] == name).collect::<Vec<_>>(),
        None => vec![],
    };
    if found.is_empty() {
        found = current().filter(family).collect();
    }
    match found[..] {
        [one] => Some(str_of(one, "id").into()),
        _ => None,
    }
}

/// The jobs whole: the saved list, else the saved rows carried over and then the seeds, rebuilt on
/// each read until the first save [D392 P3]. A model its agent renamed stays, under its new id.
pub(super) fn all(saved: &Value, groups: &[Value]) -> Vec<Value> {
    let mut jobs: Vec<Value> = match saved["jobs"].as_array() {
        Some(l) => l.clone(),
        None => (CARRIED.iter())
            .filter_map(|(key, name, line)| {
                let entries = saved["rows"][key].as_array()?;
                Some(json!({"name": name, "for": line, "entries": entries}))
            })
            .chain(seeds(groups))
            .collect(),
    };
    for l in jobs.iter_mut().filter_map(|j| j["entries"].as_array_mut()) {
        for i in 0..l.len() {
            let agent = str_of(&l[i], "agent").to_string();
            let Some(id) = renamed(saved, groups, &agent, str_of(&l[i], "model")) else {
                continue;
            };
            if l.iter()
                .any(|e| e["agent"] == agent.as_str() && e["model"] == id.as_str())
            {
                continue;
            }
            let has = model_of(groups, &agent, &id).is_some_and(|m| {
                (m["efforts"].as_array().into_iter().flatten()).any(|x| *x == l[i]["effort"])
            });
            l[i]["model"] = id.into();
            if !has {
                l[i]["effort"] = Value::Null;
            }
        }
    }
    jobs
}

/// The jobs as they stand. An entry its agent no longer lists (gone, or hidden in Settings) is
/// dropped, so it never blocks a save; an agent off, or one that lists nothing now, keeps its entries.
pub(super) fn of(saved: &Value, groups: &[Value]) -> Vec<Value> {
    let mut jobs = all(saved, groups);
    for j in &mut jobs {
        if let Some(l) = j["entries"].as_array_mut() {
            l.retain(|e| {
                let a = str_of(e, "agent");
                let lists = |g: &Value| g["models"].as_array().is_some_and(|m| !m.is_empty());
                !groups.iter().any(|g| g["provider"] == a && lists(g))
                    || model_of(groups, a, str_of(e, "model")).is_some()
            });
        }
    }
    jobs
}

/// A job by name, ignoring case.
pub(super) fn named<'a>(jobs: &'a [Value], name: &str) -> Option<&'a Value> {
    (jobs.iter()).find(|j| str_of(j, "name").to_lowercase() == name.trim().to_lowercase())
}

/// The jobs an agent names with `--job`: all but Review.
pub(super) fn startable(jobs: &[Value]) -> impl Iterator<Item = &Value> {
    jobs.iter().filter(|j| j["name"] != REVIEW)
}

/// A start with neither `--job` nor `--model`, or an unknown job [D387].
pub(super) fn refusal(jobs: &[Value]) -> String {
    let names: Vec<&str> = startable(jobs).map(|j| str_of(j, "name")).collect();
    format!(
        "Name a job with --job \"<job>\". Your jobs: {}. Or name a model with --model.",
        names.join(", ")
    )
}

/// A new list's own checks: its limits, and Review kept [D388 Q14, D385]. Its entries are
/// checked with the rules, by the caller.
pub(super) fn limits(jobs: &[Value]) -> Result<Vec<Value>, String> {
    if jobs.len() > MOST {
        return Err(format!("You can have up to {MOST} jobs."));
    }
    let mut seen: Vec<String> = vec![];
    let mut out = vec![];
    for j in jobs {
        let name = str_of(j, "name").trim();
        let line = str_of(j, "for").trim();
        if name.is_empty() {
            return Err("A job needs a name.".into());
        }
        if name.chars().count() > NAME {
            return Err(format!(
                "A job's name is at most {NAME} characters: {name:?} is longer."
            ));
        }
        if line.chars().count() > LINE {
            return Err(format!(
                "A job's \"use this for\" is at most {LINE} characters: {name}'s is longer."
            ));
        }
        if seen.contains(&name.to_lowercase()) {
            return Err(format!(
                "You have two jobs named {name:?}. Give each its own name."
            ));
        }
        seen.push(name.to_lowercase());
        let entries = j["entries"].as_array().cloned().unwrap_or_default();
        out.push(json!({"name": name, "for": line, "entries": entries}));
    }
    if !out.iter().any(|j| j["name"] == REVIEW) {
        return Err(format!(
            "The {REVIEW} job stays: reviews run on it. You can reorder and change its models, not rename or delete it."
        ));
    }
    Ok(out)
}

/// What a session's agent is told of the jobs, after its lead rule [D387, §4]; Review left out,
/// as `--reviewing` and the switch use it.
pub(crate) fn lead(jobs: &[Value]) -> String {
    let mut text = "The user's jobs say which model does which work. Every worker you start names the job whose line fits, with `brigadier start --job \"<job>\" \"<brief>\"`:\n".to_string();
    for j in startable(jobs) {
        text += &format!("- {}: {}\n", str_of(j, "name"), str_of(j, "for"));
    }
    // A start with neither --job nor --model is refused with how to fix it, so that isn't said here [D529].
    text += "To review code, a plan or a pull request: `brigadier start --reviewing session \"<what>\"`, or `--reviewing <id>` for your worker's commits; never a job.\n";
    text += "An image to make or edit: your own image tool, else `brigadier start --images \"<brief>\"`; never drawn with code.";
    text
}

/// The models image work may go to, for `--images` [D298, D337]: the user's Images model first,
/// then Codex's that make images, then the other agents', in the pickers' order, each at its own
/// default effort.
pub(super) fn drawing(groups: &[Value], first: &Value) -> Vec<Value> {
    let all = groups.iter().flat_map(|g| {
        (g["models"].as_array().into_iter().flatten())
            .filter(|m| m["draws"] == true)
            .map(|m| json!({"agent": g["provider"], "model": m["id"], "effort": null}))
    });
    let first = json!({"agent": first["agent"], "model": first["model"], "effort": null});
    let mut list: Vec<Value> = all.collect();
    list.sort_by_key(|e| e["agent"] != "codex");
    if let Some(at) = list.iter().position(|e| *e == first) {
        list[..=at].rotate_right(1);
    }
    list
}

/// "A", "A and B", "A, B and C".
pub(super) fn and(words: &[String]) -> String {
    match words {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// "A and B had no account with room, and C can't run (barred by your rule)".
pub(super) fn reasons(passed: &[(String, &str)]) -> String {
    let mut whys: Vec<&str> = vec![];
    for (_, why) in passed {
        if !whys.contains(why) {
            whys.push(why);
        }
    }
    let said: Vec<String> = (whys.iter())
        .map(|why| {
            let names: Vec<String> = (passed.iter().filter(|p| p.1 == *why))
                .map(|p| p.0.clone())
                .collect();
            format!("{} {why}", and(&names))
        })
        .collect();
    said.join(", and ")
}

/// The page's two grey lines, from the user's agents' own capabilities and names [D392 P1].
pub(super) fn notes(groups: &[Value]) -> Value {
    let agents: Vec<&dyn adapters::Adapter> = (groups.iter())
        .filter_map(|g| adapters::get(str_of(g, "provider")))
        .collect();
    let names = |f: &dyn Fn(&dyn adapters::Adapter) -> bool, own: bool| -> Vec<String> {
        (agents.iter())
            .filter(|a| f(**a))
            .map(|a| a.short_label().to_string() + if own { "'s" } else { "" })
            .collect()
    };
    let planners = names(&|a| a.plans(), true);
    let others = names(&|a| !a.plans(), false);
    let mut review = match planners.is_empty() {
        true => String::new(),
        false => format!("Plans are reviewed from {} plan mode.", and(&planners)),
    };
    if !others.is_empty() {
        let (verb, their) = if others.len() == 1 {
            ("doesn't", "its")
        } else {
            ("don't", "their")
        };
        review += &format!(
            "{}{} {verb} hand Brigadier a plan, so {their} plans aren't reviewed.",
            if review.is_empty() { "" } else { " " },
            and(&others)
        );
    }
    let mut rules = "They hold everywhere Brigadier starts a model: your pickers, sessions, workers, Brigade bosses, side chats, forks and the commit writer.".to_string();
    // What each CLI really lets the rules make of its own subagents [D376, D392 P1].
    let barred = names(&|a| a.subagents() == adapters::Subagents::Barred, true);
    let defaults = names(&|a| a.subagents() == adapters::Subagents::Defaults, true);
    let mut said = vec![];
    if !barred.is_empty() {
        said.push(format!(
            "{} can't run a model your rules bar.",
            and(&barred)
        ));
    }
    if !defaults.is_empty() {
        let their = if defaults.len() == 1 { "its" } else { "their" };
        said.push(format!(
            "{} start on the session's model and effort, but {their} agent can still pick another.",
            and(&defaults)
        ));
    }
    if !said.is_empty() {
        rules += &format!(" Your agents' own subagents: {}", said.join(" "));
    }
    json!({"review": review, "rules": rules})
}

/// The jobs and rules in words, for the agent's `brigadier models` [C5].
pub(crate) fn said(t: &Value) -> String {
    let entries = |j: &Value| {
        let list: Vec<String> = (j["entries"].as_array().into_iter().flatten())
            .map(|e| {
                let effort = e["effort"]
                    .as_str()
                    .map_or(String::new(), |x| format!(" · {x}"));
                format!("{} · {}{effort}", str_of(e, "agent"), str_of(e, "model"))
            })
            .collect();
        match list.is_empty() {
            true => "no model yet".into(),
            false => list.join(", then "),
        }
    };
    let jobs = t["jobs"].as_array().cloned().unwrap_or_default();
    let mut text =
        "Your jobs (start --job \"<job>\"); each runs its first model with room:\n".to_string();
    for j in startable(&jobs) {
        text += &format!(
            "  {}: {}\n    {}\n",
            str_of(j, "name"),
            str_of(j, "for"),
            entries(j)
        );
    }
    if let Some(r) = named(&jobs, REVIEW) {
        text += &format!(
            "  {REVIEW}, for --reviewing and the Adversarial review switch, on another agent than the author's:\n    {}\n",
            entries(r)
        );
    }
    for rule in t["rules"].as_array().into_iter().flatten() {
        text += &match str_of(rule, "never") {
            "model" => format!(
                "  Never use {} · {}\n",
                str_of(rule, "agent"),
                str_of(rule, "model")
            ),
            _ => format!(
                "  Never above {}{}\n",
                str_of(rule, "effort"),
                rule["agent"]
                    .as_str()
                    .map_or(String::new(), |a| format!(" on {a}"))
            ),
        };
    }
    text
}
