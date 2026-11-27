//! Windows' side of setup: the registry's environment, PowerShell, and PATHEXT finds.

use super::{LOGIN, Login};
use std::path::{Path, PathBuf};

/// PowerShell 7 where it's installed, else the Windows PowerShell every Windows has.
pub fn shell() -> String {
    (super::find("pwsh", &[]).map(|p| p.display().to_string())).unwrap_or_else(powershell)
}

/// Windows PowerShell, by its system folder.
pub fn powershell() -> String {
    let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    format!(r"{system}\System32\WindowsPowerShell\v1.0\powershell.exe")
}

/// The registry's environment again, as a new process would get it (an install may have changed
/// it): the machine's PATH then the user's, and each credential variable, the user's first.
pub fn refresh() -> Login {
    let (machine, user) = crate::os::registry_env("Path");
    let path = [machine, user]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(";");
    let all = crate::adapters::all();
    let vars = (all.iter().flat_map(|a| a.keys())).filter_map(|k| {
        let (machine, user) = crate::os::registry_env(&k);
        let v = user.or(machine).or_else(|| std::env::var(&k).ok())?;
        (!v.is_empty()).then_some((k, v))
    });
    let login = Login {
        path: Some(path)
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default()),
        vars: vars.collect(),
    };
    *LOGIN.lock().unwrap() = Some(login.clone());
    login
}

/// `bin` in `dir`, as given or with one of PATHEXT's extensions. An npm `.cmd` shim is the
/// program it starts where that's an exe of the package's: Windows runs a `.cmd` through cmd, which
/// refuses an argument with a line break, as a prompt has.
pub(super) fn exe_in(dir: &Path, bin: &str) -> Option<PathBuf> {
    let found = brigadier_frames::procs::find(bin, Some(dir.to_str()?), "")?;
    let shim = found
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd"));
    Some(match shim {
        true => shim_exe(&found, bin).unwrap_or(found),
        false => found,
    })
}

/// The exe an npm shim starts: its target itself, or the first `<bin>.exe` in the target's package.
/// shortcut: a package whose program is a script alone keeps its shim; resolve node plus the
/// script if one shows up.
fn shim_exe(shim: &Path, bin: &str) -> Option<PathBuf> {
    let text = std::fs::read_to_string(shim).ok()?;
    let rel = text.split('"').find_map(|w| w.strip_prefix(r"%dp0%\"))?;
    let target = shim.parent()?.join(rel);
    if target
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
    {
        return target.is_file().then_some(target);
    }
    // `node_modules\<package>`, or `\@scope\<package>`, the target's first folders.
    let parts: Vec<_> = std::path::Path::new(rel).components().collect();
    let depth = if rel.contains(r"\@") { 3 } else { 2 };
    let package = parts
        .iter()
        .take(depth)
        .fold(shim.parent()?.to_path_buf(), |p, c| p.join(c));
    let want = format!("{bin}.exe");
    let mut dirs = vec![(package, 0)];
    while let Some((dir, level)) = dirs.pop() {
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let (path, kind) = (e.path(), e.file_type().ok()?);
            if kind.is_file() && e.file_name().eq_ignore_ascii_case(&want) {
                return Some(path);
            }
            if kind.is_dir() && level < 5 {
                dirs.push((path, level + 1));
            }
        }
    }
    None
}

pub(super) fn is_exe(p: &Path) -> bool {
    p.is_file()
}

/// What every Windows program expects to find, from this process's own environment: a child
/// started without them misses its profile, its temp folder and its system's own folders.
pub fn system_env() -> Vec<(String, String)> {
    const KEPT: [&str; 25] = [
        "SystemRoot",
        "SystemDrive",
        "windir",
        "ComSpec",
        "PATHEXT",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "CommonProgramFiles",
        "CommonProgramFiles(x86)",
        "USERNAME",
        "USERDOMAIN",
        "COMPUTERNAME",
        "TEMP",
        "TMP",
        "OS",
        "PROCESSOR_ARCHITECTURE",
        "NUMBER_OF_PROCESSORS",
        "PSModulePath",
    ];
    let kept = KEPT
        .iter()
        .filter_map(|k| Some((k.to_string(), std::env::var(k).ok()?)));
    kept.chain(long_paths()).collect()
}

/// Git's paths past 260 characters, as a worktree under `sessions/` soon has: `core.longpaths`
/// through Git's own variables, or those already set (the user's, or ours at start) as they are.
pub fn long_paths() -> Vec<(String, String)> {
    if std::env::var_os("GIT_CONFIG_COUNT").is_some() {
        let git = |k: &str| {
            ["COUNT", "KEY_", "VALUE_"]
                .iter()
                .any(|p| k.starts_with(&format!("GIT_CONFIG_{p}")))
        };
        return std::env::vars().filter(|(k, _)| git(k)).collect();
    }
    let vars = [
        ("GIT_CONFIG_COUNT", "1"),
        ("GIT_CONFIG_KEY_0", "core.longpaths"),
        ("GIT_CONFIG_VALUE_0", "true"),
    ];
    vars.map(|(k, v)| (k.to_string(), v.to_string())).to_vec()
}
