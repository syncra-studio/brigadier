//! The account a session's backend runs on [D51]: its CLI home in the data folder.

use crate::fold::Fold;
use crate::{Spec, adapters, check_id, data_dir};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// An account's CLI home: `accounts/<id>` in the data folder [D51].
pub fn account_home(data: &Path, id: &str) -> PathBuf {
    data.join("accounts").join(id)
}

/// Whether added account `id` was removed: its home is gone, so its chats go on with the
/// computer's login [C40]. "" (the login) never is.
pub fn gone(data: &Path, id: &str) -> bool {
    !id.is_empty() && !account_home(data, id).is_dir()
}

/// Drops from a session's fold the accounts that were removed, for the session folder `dir`.
pub fn drop_gone(dir: &Path, f: &mut Fold) {
    if let Some(data) = dir.parent().and_then(Path::parent) {
        f.drop_accounts(|id| gone(data, id));
    }
}

/// When each removed account went, by id, for the session folder `dir`: from then its chats are on
/// the computer's login, so a fold drops it at that time and what it shows before keeps it [C40].
pub fn removed(dir: &Path) -> BTreeMap<String, u64> {
    let Some(data) = dir.parent().and_then(Path::parent) else {
        return BTreeMap::new();
    };
    // Only once its home is gone: a Remove cut short before that took nothing away.
    (store(data)["removed"].as_object().into_iter().flatten())
        .filter(|(id, _)| gone(data, id))
        .filter_map(|(id, at)| Some((id.clone(), at.as_u64()?)))
        .collect()
}

/// Drops from the fold each account removed by the time `item` was logged.
pub fn drop_removed(f: &mut Fold, removed: &BTreeMap<String, u64>, item: &Value) {
    if !removed.is_empty() && !f.accounts.is_empty() {
        let ts = item["ts"].as_u64().unwrap_or(0);
        f.drop_accounts(|id| removed.get(id).is_some_and(|&at| ts >= at));
    }
}

fn store(data: &Path) -> Value {
    std::fs::read(data.join("accounts.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Whether added account entry `e` (accounts.json) is being removed: its mark names the live
/// process removing it, so one a crash left counts no more [C40].
pub fn marked(e: &Value) -> bool {
    (e["removing"].as_i64()).is_some_and(|pid| brigadier_frames::procs::alive(pid as i32))
}

/// Whether Remove is taking away an account session folder `dir` ran on: no turn starts on it,
/// whichever agent the next one picks, nor a switch to it [C40].
pub fn leaving(dir: &Path) -> bool {
    let Some(data) = dir.parent().and_then(Path::parent) else {
        return false;
    };
    crate::fold(dir, true).is_ok_and(|f| taken(data, &f.fold.accounts))
}

/// Whether Remove is taking away one of `accounts` (agent → id), which a run is about to use.
pub fn taken(data: &Path, accounts: &BTreeMap<String, String>) -> bool {
    let v = store(data);
    (v["accounts"].as_array().into_iter().flatten()).any(|e| {
        marked(e)
            && (accounts.iter()).any(|(b, id)| e["agent"] == b.as_str() && e["id"] == id.as_str())
    })
}

/// The data folder a session's folder sits in (`<data>/sessions/<id>`).
pub fn data_of(spec: &Spec) -> PathBuf {
    spec.dir
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(data_dir)
}

/// The spec `backend` runs with now: the account and model its last switch set [D51]. `account`
/// overrides the current one (a recorded conversation's, for delete); "" is the computer's login.
pub fn as_run(spec: &Spec, f: &Fold, backend: &str, account: Option<&str>) -> Spec {
    let mut run = spec.clone();
    // A session saved as "pty" launches as chat like any other [D293, D295].
    run.mode = "pipe".into();
    let id = account.or_else(|| f.accounts.get(backend).map(String::as_str));
    let var = adapters::get(backend)
        .and_then(|a| a.accounts())
        .map(|a| a.var);
    run.account = id
        .filter(|id| !id.is_empty() && check_id(id).is_ok() && !gone(&data_of(spec), id))
        .zip(var)
        .map(|(id, var)| (var.to_string(), account_home(&data_of(spec), id)));
    if let Some(m) = f.models.get(backend) {
        run.model = Some(m.clone());
    } else if backend != spec.backend {
        run.model = None;
    }
    run.grants = f.grants.clone();
    run.resume_at = f.pin.get(backend).cloned();
    run.branch = f.branching.contains(backend);
    if let Some(e) = f.efforts.get(backend) {
        run.effort = Some(e.clone());
    } else if backend != spec.backend {
        run.effort = None;
    }
    // As the app last set it for that agent, else as the session started.
    if f.models.contains_key(backend) {
        run.fast = f.fast.contains(backend);
    } else if backend != spec.backend {
        run.fast = false;
    }
    run
}
