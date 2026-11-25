//! The session's permission level: the user's pick, and Brigadier's own change for a night.

use super::new_cid;
use crate::owner;
use brigadier_core::{self as core, Spec, adapters};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// The session's permission level: a running turn takes it at once [D166], else its next turn start [D129, D170].
pub fn level(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = crate::arg(args, 1)?;
    let mut spec = core::load(data, id)?;
    let op = crate::flag(args, "--op");
    if let Some(want) = args.get(2).filter(|w| !w.starts_with("--")) {
        // Held to Ask, it can't be raised: the project's trust is the way [D166, D187].
        if want != "ask" && crate::models::held(data, spec.project.as_deref()) {
            return Err(io::Error::other(
                "This folder isn't trusted, so sessions here ask first. Change it in the project's settings.",
            ));
        }
        spec.level = Some(want.clone());
        spec.level_op = op.map(String::from);
        at_level(data, &spec)?;
        crate::overnight::picked(&spec.dir)?;
    }
    Ok(json!({"ok": true, "level": spec.level, "op": op}))
}

/// The same for Brigadier's own change: a night's Full access, then the level it took over.
pub(crate) fn relevel(data: &Path, id: &str, level: Option<String>) -> io::Result<()> {
    let spec = core::load(data, id)?;
    at_level(data, &Spec { level, ..spec })
}

fn at_level(data: &Path, spec: &Spec) -> io::Result<()> {
    let id = spec.id.as_str();
    let f = core::fold(&spec.dir, true)?;
    // Checked against the agent the next message goes to [D225].
    if let Some(a) = adapters::get(crate::models::next_agent(spec, &f.fold)) {
        core::level(spec, a, false).map_err(io::Error::other)?;
    }
    // A running turn takes it now, before it's saved, so no cut races it [D166].
    let ping = (!f.fold.turns.is_empty()).then(|| owner::call(data, id, json!({"op": "ping"})));
    if let Some(Ok(ping)) = ping.filter(|p| p.as_ref().is_ok_and(|p| p["child"].is_number())) {
        let child = Some(ping["spawn"].as_u64().unwrap_or(0));
        let call = |req| owner::call(data, id, req);
        core::relevel(spec, &f.fold, child, &call, &new_cid()).map_err(|e| {
            io::Error::other(
                e["why"]
                    .as_str()
                    .or(e["error"].as_str())
                    .unwrap_or("refused")
                    .to_string(),
            )
        })?;
    }
    core::create(data, spec)?;
    Ok(())
}
