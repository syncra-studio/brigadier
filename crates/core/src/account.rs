//! The account a session's backend runs on [D51]: its CLI home in the data folder.

use crate::fold::Fold;
use crate::{Spec, adapters, check_id, data_dir};
use std::path::{Path, PathBuf};

/// An account's CLI home: `accounts/<id>` in the data folder [D51].
pub fn account_home(data: &Path, id: &str) -> PathBuf {
    data.join("accounts").join(id)
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
        .filter(|id| !id.is_empty() && check_id(id).is_ok())
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
