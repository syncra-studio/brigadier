//! The message writer [D1029, D1107]: a PR's empty title and message on Settings' Write with model
//! [D1224], anything else on the session's own agent at its cheapest model; a local model only when
//! the computer is offline.

use brigadier_core::adapters::{self, ModelInfo};
use brigadier_core::fold::Fold;
use brigadier_core::{self as core, Spec, writer};
use serde_json::Value;
use std::fs;
use std::path::Path;

/// Each model an agent's last check listed, in any folder, the first folder's list that has any.
pub(crate) fn models(data: &Path, name: &str) -> Vec<ModelInfo> {
    let path = data.join("agents").join(format!("{name}.json"));
    let all: Value = (fs::read(path).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let lists = all.as_object().into_iter().flat_map(|m| m.values());
    let found = lists
        .filter_map(|c| c["models"].as_array())
        .find(|l| !l.is_empty());
    (found.into_iter().flatten())
        .map(|m| ModelInfo {
            id: m["id"].as_str().unwrap_or("").into(),
            name: m["name"].as_str().unwrap_or("").into(),
            local: m["local"] == true,
            cost: m["cost"].as_f64(),
            efforts: (m["efforts"].as_array().into_iter().flatten())
                .filter_map(|e| e.as_str().map(String::from))
                .collect(),
            ..ModelInfo::default()
        })
        .filter(|m| !m.id.is_empty())
        .collect()
}

/// The agents ready now with their models, in the pickers' order: none off, hidden or barred.
fn ready(data: &Path) -> Vec<Value> {
    let groups = crate::models::run(data, &["models".into()]).unwrap_or_default();
    let all = groups["groups"].as_array().cloned().unwrap_or_default();
    (all.into_iter())
        .filter(|g| {
            g["unavailable"].is_null() && g["models"].as_array().is_some_and(|m| !m.is_empty())
        })
        .collect()
}

/// The saved Write with model, while it's available.
pub(crate) fn chosen(data: &Path) -> Option<writer::Choice> {
    let saved = writer::choice(data).ok()??;
    let mut ready = ready(data).into_iter();
    let group = ready.find(|g| g["provider"] == *saved.backend)?;
    let listed = group["models"]
        .as_array()?
        .iter()
        .any(|m| m["id"] == *saved.model);
    listed.then_some(saved)
}

/// What Write with starts on: the first ready agent's light model, else its default, else its first.
pub(crate) fn first(data: &Path) -> Option<writer::Choice> {
    let group = ready(data).into_iter().next()?;
    let backend = group["provider"].as_str()?.to_string();
    let listed = group["models"].as_array()?;
    let id = |m: &Value| m["id"].as_str().map(String::from);
    let default = (listed.iter().find(|m| m["default"] == true)).or(listed.first());
    let default = default.and_then(id)?;
    let infos: Vec<ModelInfo> = (listed.iter())
        .filter_map(|m| {
            Some(ModelInfo {
                id: id(m)?,
                name: m["name"].as_str().unwrap_or("").into(),
                cost: m["cost"].as_f64(),
                ..ModelInfo::default()
            })
        })
        .collect();
    let light = adapters::get(&backend)?.cheap(Some(&default), &infos);
    Some(writer::Choice {
        model: light.unwrap_or(default),
        backend,
    })
}

/// One write of `prompt` (built from the session's own asks) on `chosen`, else its agent at its
/// cheapest model, else its own model at its lowest effort; offline, on a local model any agent listed [D1029]; none a rule bars [D376].
/// With the model that wrote it; the reason why not, else.
pub(crate) fn written_for(
    data: &Path,
    spec: &Spec,
    f: &Fold,
    active: &fs::File,
    chosen: Option<&writer::Choice>,
    prompt: impl Fn(&[String]) -> String,
) -> Result<(String, Option<String>), String> {
    // The accounts this write runs on, checked under the lock `active` holds, which Remove's busy
    // check tries [C40].
    if core::taken(data, &f.accounts) {
        return Err("This account is being removed.".into());
    }
    let prompt = prompt(&writer::asks(&spec.dir));
    // Each candidate a rule bars is skipped for the next: the chosen, the cheap, the session's own,
    // the offline one [D376].
    let ok = |b: &str, m: Option<&str>| crate::routing::launch(data, &spec.cwd, b, m, None);
    let chosen = chosen.filter(|c| ok(&c.backend, Some(&c.model)).is_ok());
    let backend = match chosen {
        Some(choice) => choice.backend.clone(),
        None => match f.backend.as_str() {
            "" => spec.backend.clone(),
            b => b.to_string(),
        },
    };
    let a = adapters::get(&backend).ok_or_else(|| format!("no agent {backend}"))?;
    let account = f.accounts.get(&backend).cloned().unwrap_or_default();
    // Never on a login Providers doesn't show [C36]; a writer has no thread to say it fell back to it.
    if account.is_empty() && !crate::accounts::login_ok(data, a) {
        return Err(format!(
            "this computer's login ({}) is signed out. Sign in to it in Providers.",
            a.label()
        ));
    }
    let mut run = core::as_run(spec, f, &backend, None);
    let mut listed = models(data, &backend);
    let cheap = |listed: &mut Vec<ModelInfo>| loop {
        let m = a.cheap(run.model.as_deref(), listed)?;
        if ok(&backend, Some(&m)).is_ok() {
            break Some(m);
        }
        listed.retain(|x| x.id != m);
    };
    let model = chosen
        .map(|c| c.model.clone())
        .or_else(|| cheap(&mut listed))
        .or_else(|| run.model.clone());
    if let Some(model) = model {
        run.effort =
            (listed.iter().find(|m| m.id == model)).and_then(|m| m.efforts.first().cloned());
        run.model = Some(model);
    }
    // Its effort too: above a cap, it runs at the cap [D376].
    let check = |run: Spec, agent: &str| {
        Spec {
            rules: Some(crate::routing::launch),
            ..run
        }
        .ruled(agent)
    };
    let mut run = check(run, &backend)?;
    let ready = |run: &mut Spec, a: &dyn adapters::Adapter| {
        run.cid = Some(adapters::uuid());
        run.dir = writer::home(&spec.dir);
        // It only writes a message: none of the user's skills, servers, plugins or hooks.
        run.naked = true;
        run.level = a.can().levels.first().map(|l| l.to_string());
        run.grants = vec![];
    };
    ready(&mut run, a);
    let failure = match writer::write(a, &run, &account, &prompt, active, writer::WRITE_SECS) {
        Ok(text) => return Ok((text, run.model)),
        Err(failure) => failure,
    };
    if !failure.offline {
        return Err(failure.why);
    }
    for local in adapters::all() {
        let mut local_models = models(data, local.name()).into_iter();
        let Some(model) = local_models.find(|m| m.local && ok(local.name(), Some(&m.id)).is_ok())
        else {
            continue;
        };
        let mut run = core::as_run(spec, f, local.name(), None);
        (run.account, run.model, run.effort) = (None, Some(model.id), None);
        let mut run = check(run, local.name())?;
        ready(&mut run, local);
        return writer::write(local, &run, "", &prompt, active, writer::WRITE_SECS)
            .map(|text| (text, run.model))
            .map_err(|e| e.why);
    }
    Err(failure.why)
}
