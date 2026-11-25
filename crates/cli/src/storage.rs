//! Settings › Storage: what Brigadier takes on disk, by kind and by session, and Free up space,
//! which takes only what is made again (a finished worker's build files) or left over once a chat
//! is archived, never unmerged work or a chat.
//! `storage` lists the sessions and what could go of each; `storage <kind>` measures one kind;
//! `storage free <group> <id>` frees one session's part of a group, each guard read again first.

use crate::{arg, owner, workers};
use brigadier_core::{self as core, Spec, background, fold, projects, session, share, worktrees};
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;

/// Folders measured at once: the disk's own pace, not the processor's.
const AT_ONCE: usize = 8;
/// Live chats' finished workers' build files, and what archived chats left.
const BUILD: &str = "build";
const LEFT: &str = "left";

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    match args.get(1).map(String::as_str) {
        None => list(data),
        Some("free") => free(data, arg(args, 2)?, arg(args, 3)?),
        Some("browser") => {
            let size = ["browser", "chromium"].map(|d| size(&data.join(d), &[]));
            Ok(json!({"ok": true, "total": size.iter().sum::<u64>()}))
        }
        Some(kind @ ("build" | "worktrees" | "temp" | "history")) => {
            let sizes = each(&specs(data), |spec| measure(data, spec, kind));
            Ok(json!({"ok": true, "sizes": sizes}))
        }
        Some(_) => Err(io::Error::other(crate::USAGE)),
    }
}

fn specs(data: &Path) -> Vec<Spec> {
    let ids = core::ids(data);
    ids.iter()
        .filter_map(|id| core::load(data, id).ok())
        .collect()
}

/// `work` on every session, several at a time, by id.
fn each<T: Send>(specs: &[Spec], work: impl Fn(&Spec) -> T + Sync) -> BTreeMap<String, T> {
    let (next, out) = (Mutex::new(specs.iter()), Mutex::new(BTreeMap::new()));
    thread::scope(|scope| {
        for _ in 0..AT_ONCE {
            scope.spawn(|| {
                loop {
                    let Some(spec) = next.lock().unwrap().next() else {
                        return;
                    };
                    let done = work(spec);
                    out.lock().unwrap().insert(spec.id.clone(), done);
                }
            });
        }
    });
    out.into_inner().unwrap()
}

/// The records of the worktrees a session made: its own, and a folder chat's claims.
fn records(spec: &Spec) -> Vec<PathBuf> {
    let claims = core::folder::claims(&spec.dir);
    let all = [spec.dir.clone()].into_iter();
    (all.chain(claims.into_iter().map(|(_, rec)| rec)))
        .filter(|rec| worktrees::present(rec))
        .collect()
}

/// The folders holding its code: those worktrees, and its own folder when that's in the session's.
fn code(spec: &Spec) -> Vec<PathBuf> {
    let made = records(spec);
    let mut all: Vec<PathBuf> = made.iter().filter_map(|r| worktrees::folder(r)).collect();
    let own = PathBuf::from(&spec.cwd);
    all.extend(own.starts_with(&spec.dir).then_some(own));
    all.sort();
    // One inside another is measured with it.
    all.dedup_by(|inner, outer| inner.starts_with(outer));
    all
}

fn built(data: &Path, spec: &Spec) -> Vec<PathBuf> {
    let project = spec.project.as_deref();
    let picks = (project.and_then(|p| projects::get(data, p).ok()))
        .map(|p| p.include)
        .unwrap_or_default();
    (records(spec).iter())
        .flat_map(|rec| {
            // A folder chat's claims have no picks of their own.
            let picks = if *rec == spec.dir { &picks[..] } else { &[] };
            worktrees::lost::rebuilt(rec, picks).unwrap_or_default()
        })
        .collect()
}

fn measure(data: &Path, spec: &Spec, kind: &str) -> u64 {
    let sum = |paths: &[PathBuf], skip: &[PathBuf]| paths.iter().map(|p| size(p, skip)).sum();
    let tmp = background::tmp(&spec.dir);
    match kind {
        "build" => sum(&built(data, spec), &[]),
        "worktrees" => sum(&code(spec), &built(data, spec)),
        "temp" => size(&tmp, &[]),
        _ => size(&spec.dir, &[code(spec), vec![tmp]].concat()),
    }
}

/// Bytes a folder takes on disk, its links not followed, a file with several names counted once.
fn size(path: &Path, skip: &[PathBuf]) -> u64 {
    let (mut stack, mut seen, mut total) = (vec![path.to_path_buf()], HashSet::new(), 0);
    while let Some(next) = stack.pop() {
        if skip.contains(&next) {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&next) else {
            continue;
        };
        if !meta.is_dir() && meta.nlink() > 1 && !seen.insert((meta.dev(), meta.ino())) {
            continue;
        }
        total += meta.blocks() * 512;
        if meta.is_dir() {
            let inside = fs::read_dir(&next).into_iter().flatten().flatten();
            stack.extend(inside.map(|e| e.path()));
        }
    }
    total
}

/// What the page says of a session and what could go of it: kind by kind, the group it goes with.
struct State {
    archived: bool,
    working: bool,
    unmerged: bool,
    goes: BTreeMap<&'static str, &'static str>,
}

fn state(data: &Path, spec: &Spec, all: &[procs::Proc]) -> State {
    let id = &spec.id;
    let (root, _) = workers::place(data, id);
    let lives = [&spec.dir, &core::session_dir(data, &root)].map(|d| session::lifecycle(d));
    let archived = lives.iter().any(|(at, _)| at.is_some());
    let moving = lives.iter().any(|(_, op)| !op.is_null()) || workers::closing(data, id);
    let working = workers::at_work(data, id, all) || left(data, spec, all);
    let made = records(spec);
    // Anything git can't answer counts as unmerged, so it stays.
    let unmerged = !made.is_empty() && !matches!(worktrees::unlanded(&spec.dir), Ok(None));
    let link = workers::link(data, id).filter(|l| !l.session);
    // Another session working in one of its folders keeps them all.
    let shared = || {
        (made.iter().filter_map(|r| worktrees::folder(r)))
            .any(|f| !share::in_folder(data, &f, Some(id)).is_empty())
    };
    let mut goes = BTreeMap::new();
    match (working || moving, archived) {
        (true, _) => {}
        (_, true) => {
            goes.insert("temp", LEFT);
            if !made.is_empty() && !shared() {
                goes.insert("build", LEFT);
                let lost = || worktrees::lost::losses(data, std::slice::from_ref(id));
                // An ignored file restore wouldn't bring back is as good as unmerged.
                if !unmerged && lost().is_empty() {
                    goes.insert("worktrees", LEFT);
                }
            }
        }
        // A worker's result says it has finished: one waiting for an answer or a pick hasn't.
        _ if link.is_some_and(|l| !l.last.is_null()) && !made.is_empty() && !shared() => {
            goes.insert("build", BUILD);
        }
        _ => {}
    }
    State {
        archived,
        working,
        unmerged,
        goes,
    }
}

/// Whether something its turns started still runs (a dev server), which may use its files.
fn left(data: &Path, spec: &Spec, all: &[procs::Proc]) -> bool {
    core::fold(&spec.dir, true).map_or(true, |f| {
        let live = fold::live(&f.fold, owner::state(data, &spec.id), &spec.dir, all);
        !live.left.is_empty() || live.owner == fold::Owner::Frozen
    })
}

/// The chats, each with its workers of any depth; sizes come by kind.
fn list(data: &Path) -> io::Result<Value> {
    let specs = specs(data);
    let all = procs::all();
    let states = each(&specs, |spec| state(data, spec, &all));
    let names: BTreeMap<String, String> = (projects::list(data)?.into_iter())
        .map(|p| (p.id, p.name))
        .collect();
    let ids: BTreeSet<&str> = specs.iter().map(|s| s.id.as_str()).collect();
    let mut chats: BTreeMap<String, Value> = BTreeMap::new();
    let mut under: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for spec in &specs {
        let s = &states[&spec.id];
        let (root, _) = workers::place(data, &spec.id);
        let worker = root != spec.id && ids.contains(root.as_str());
        let title = match workers::link(data, &spec.id).filter(|_| worker) {
            Some(link) => link.title,
            None => share::title(spec),
        };
        let project = spec.project.as_deref().and_then(|p| names.get(p));
        let row = json!({"id": spec.id, "title": title, "project": project, "worker": worker,
            "archived": s.archived, "working": s.working, "unmerged": s.unmerged, "goes": s.goes});
        match worker {
            true => under.entry(root).or_default().push(row),
            false => drop(chats.insert(spec.id.clone(), row)),
        }
    }
    let chats: Vec<Value> = (chats.into_iter())
        .map(|(id, mut chat)| {
            chat["workers"] = under.remove(&id).unwrap_or_default().into();
            chat
        })
        .collect();
    Ok(json!({"ok": true, "free": disk_free(data), "chats": chats}))
}

fn disk_free(data: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(data.as_os_str().as_bytes()).ok()?;
    let mut s = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
    if unsafe { libc::statvfs(path.as_ptr(), s.as_mut_ptr()) } != 0 {
        return None;
    }
    let s = unsafe { s.assume_init() };
    Some(s.f_bavail as u64 * s.f_frsize)
}

/// Frees `id`'s part of `group`, if it still goes: the kinds that went. Under the session's lock, so
/// no turn starts meanwhile, and with its idle host ended, so its next message sets up again.
fn free(data: &Path, group: &str, id: &str) -> io::Result<Value> {
    let spec = core::load(data, id)?;
    let _one = worktrees::lock(&spec.dir)?;
    let goes = state(data, &spec, &procs::all()).goes;
    let takes = |kind: &str| goes.get(kind).is_some_and(|g| *g == group);
    let mut went = vec![];
    if !["build", "worktrees", "temp"].iter().any(|k| takes(k)) {
        return Ok(json!({"ok": true, "went": went}));
    }
    owner::release(data, id)?;
    // The build files first, also of a worktree that goes: what's left then goes in a moment.
    if takes("build") {
        for path in built(data, &spec) {
            fs::remove_dir_all(path)?;
        }
        for name in ["setup.started", "setup.exit", "setup.log"] {
            crate::remove(&spec.dir.join(name))?;
        }
        went.push("build");
    }
    if takes("temp") {
        match fs::remove_dir_all(background::tmp(&spec.dir)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => went.push("temp"),
        }
    }
    if takes("worktrees") {
        for rec in records(&spec) {
            // The session's own is locked already.
            let _claim = (rec != spec.dir)
                .then(|| worktrees::lock(&rec))
                .transpose()?;
            worktrees::free(&rec)?;
        }
        went.push("worktrees");
    }
    Ok(json!({"ok": true, "went": went}))
}
