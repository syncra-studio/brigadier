//! The message writer [D1029, D1107], as feedback reports use it: the session's own agent at its
//! cheapest model, and a local model only when the computer is offline.

use brigadier_core::adapters::{self, ModelInfo};
use brigadier_core::fold::Fold;
use brigadier_core::{self as core, Spec, writer};
use serde_json::Value;
use std::fs;
use std::path::Path;

/// Each model an agent's last check listed, in any folder, the first folder's list that has any.
fn models(data: &Path, name: &str) -> Vec<ModelInfo> {
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
            local: m["local"] == true,
            efforts: (m["efforts"].as_array().into_iter().flatten())
                .filter_map(|e| e.as_str().map(String::from))
                .collect(),
            ..ModelInfo::default()
        })
        .filter(|m| !m.id.is_empty())
        .collect()
}

/// One write of `prompt` (built from the session's own asks) on `chosen`, else its agent at its
/// cheapest model; offline, on a local model any agent listed [D1029]; none a rule bars [D376].
/// The reason why not, else.
pub(crate) fn written_for(
    data: &Path,
    spec: &Spec,
    f: &Fold,
    active: &fs::File,
    chosen: Option<&writer::Choice>,
    prompt: impl Fn(&[String]) -> String,
) -> Result<String, String> {
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
        .or_else(|| cheap(&mut listed));
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
        run.level = a.can().levels.first().map(|l| l.to_string());
        run.grants = vec![];
    };
    ready(&mut run, a);
    let failure = match writer::write(a, &run, &account, &prompt, active) {
        Ok(text) => return Ok(text),
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
        return writer::write(local, &run, "", &prompt, active).map_err(|e| e.why);
    }
    Err(failure.why)
}
