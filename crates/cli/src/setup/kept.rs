//! Each agent's last check, kept per folder, so a launch shows it at once [D30].

use brigadier_core::{self as core, adapters::Adapter};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::{fs, io};

/// `agents/<name>.json`, `{cwd: check}`.
fn checks_path(data: &Path, a: &dyn Adapter) -> PathBuf {
    data.join("agents").join(format!("{}.json", a.name()))
}

pub(super) fn last_check(data: &Path, a: &dyn Adapter, cwd: &Path) -> Option<Value> {
    let all: Value = serde_json::from_slice(&fs::read(checks_path(data, a)).ok()?).ok()?;
    all.get(cwd.to_str()?).filter(|v| v.is_object()).cloned()
}

/// Keeps the check before releasing the lock, so a waiting caller gets the same result.
pub(super) fn keep_check(data: &Path, a: &dyn Adapter, cwd: &Path, out: &Value) -> io::Result<()> {
    let path = checks_path(data, a);
    let mut all: Value = fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({}));
    if let (Some(map), Some(cwd)) = (all.as_object_mut(), cwd.to_str()) {
        map.insert(cwd.into(), out.clone());
        fs::create_dir_all(path.parent().unwrap())?;
        core::write_atomic(&path, all.to_string().as_bytes())?;
    }
    Ok(())
}
