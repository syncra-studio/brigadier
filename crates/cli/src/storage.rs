//! Settings › Storage: what Brigadier takes on disk, by kind and by session, and Free up space,
//! which takes only what is made again (a finished worker's build files) or left over once a chat
//! is archived, never unmerged work or a chat.
//! `storage` lists the sessions and what could go of each; `storage <kind>` measures one kind;
//! `storage free <group> <id>` frees one session's part of a group, each guard read again first.

use crate::{arg, owner, workers};
use brigadier_core::{self as core, Spec, background, fold, projects, session, share, worktrees};
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
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
const BROWSER: &[&str] = &["browser", "chromium"];
/// Brigadier's own programs, with nothing to free.
const PROGRAMS: [&str; 1] = ["bin"];
/// In a kind's total but no session's, which can't be ids: the rest of the data folder, and files
/// with a name elsewhere too, which freeing one session wouldn't give back.
const REST: &str = "@rest";
const SHARED: &str = "@shared";

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    match args.get(1).map(String::as_str) {
        None => list(data),
        Some("free") => free(data, arg(args, 2)?, arg(args, 3)?),
        Some(kind @ ("browser" | "programs")) => {
            let dirs = match kind {
                "browser" => BROWSER,
                _ => &PROGRAMS,
            };
            let dirs: Vec<PathBuf> = dirs.iter().map(|d| data.join(d)).collect();
            let size = size(&dirs, &[]);
            Ok(json!({"ok": true, "total": size.total()}))
        }
        Some(kind @ ("build" | "worktrees" | "temp" | "history")) => {
            let specs = specs(data);
            let mut all = each(&specs, |spec| measure(data, spec, kind));
            if kind == "history" {
                all.insert(REST.into(), size(&rest(data, &specs), &[]));
            }
            let mut sizes: BTreeMap<&str, u64> = BTreeMap::new();
            let mut shared: HashMap<(u64, u64), u64> = HashMap::new();
            for (id, size) in &all {
                sizes.insert(id, size.own);
                shared.extend(&size.shared);
            }
            // One with a name in the programs too is theirs.
            let programs = PROGRAMS.map(|d| data.join(d));
            for file in size(&programs, &[]).shared.keys() {
                shared.remove(file);
            }
            sizes.insert(SHARED, shared.values().copied().sum());
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

/// What the data folder holds besides the sessions, the browser and its programs: Home's draft, the search index,
/// and what deleted sessions left.
fn rest(data: &Path, specs: &[Spec]) -> Vec<PathBuf> {
    let inside = |dir: &Path| fs::read_dir(dir).into_iter().flatten().flatten();
    let (sessions, known) = (data.join("sessions"), |p: &PathBuf| {
        specs.iter().any(|s| s.dir == *p)
    });
    let top = inside(data).map(|e| e.path());
    let apart = BROWSER.iter().chain(&PROGRAMS).map(|d| data.join(d));
    let top = top.filter(|p| *p != sessions && !apart.clone().any(|d| *p == d));
    let gone = inside(&sessions).map(|e| e.path()).filter(|p| !known(p));
    top.chain(gone).collect()
}

/// Its worktrees' build files, a shared one's too.
fn built(data: &Path, spec: &Spec) -> Vec<PathBuf> {
    session::built_in(data, spec, &records(spec)).unwrap_or_default()
}

fn measure(data: &Path, spec: &Spec, kind: &str) -> Size {
    let tmp = background::tmp(&spec.dir);
    match kind {
        "build" => size(&built(data, spec), &[]),
        "worktrees" => size(&code(spec), &built(data, spec)),
        "temp" => size(&[tmp], &[]),
        _ => size(
            std::slice::from_ref(&spec.dir),
            &[code(spec), vec![tmp]].concat(),
        ),
    }
}

/// Bytes on disk: those that go with the folders, and by file those with a name outside them too.
struct Size {
    own: u64,
    shared: HashMap<(u64, u64), u64>,
}

impl Size {
    fn total(&self) -> u64 {
        self.own + self.shared.values().sum::<u64>()
    }
}

/// What folders take together, their links not followed, a file with several names counted once.
/// shortcut: a file cloned by APFS counts whole; tell them apart if sizes read far too high.
fn size(paths: &[PathBuf], skip: &[PathBuf]) -> Size {
    let (mut stack, mut total) = (paths.to_vec(), 0);
    let mut names: HashMap<(u64, u64), (u64, u64, u64)> = HashMap::new();
    while let Some(next) = stack.pop() {
        if skip.contains(&next) {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&next) else {
            continue;
        };
        let bytes = meta.blocks() * 512;
        if !meta.is_dir() && meta.nlink() > 1 {
            let new = (0, meta.nlink(), bytes);
            names.entry((meta.dev(), meta.ino())).or_insert(new).0 += 1;
            continue;
        }
        total += bytes;
        if meta.is_dir() {
            let inside = fs::read_dir(&next).into_iter().flatten().flatten();
            stack.extend(inside.map(|e| e.path()));
        }
    }
    let mut shared = HashMap::new();
    for (file, (here, all, bytes)) in names {
        match here < all {
            true => drop(shared.insert(file, bytes)),
            false => total += bytes,
        }
    }
    Size { own: total, shared }
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
    // Another session working in one of its folders keeps them all.
    let alone = || session::own(data, spec).len() == made.len();
    let mut goes = BTreeMap::new();
    match (working || moving, archived) {
        (true, _) => {}
        (_, true) => {
            let whole = alone() && session::may_take(data, spec);
            // One its chat's archive left is archived as a whole, or not at all.
            if whole || lives[0].0.is_some() {
                // A repository in there may hold work of its own.
                if !worktrees::lost::repo_inside(&background::tmp(&spec.dir), &[]) {
                    goes.insert("temp", LEFT);
                }
                if !made.is_empty() && alone() {
                    goes.insert("build", LEFT);
                }
                if !made.is_empty() && whole {
                    goes.insert("worktrees", LEFT);
                }
            }
        }
        _ if !made.is_empty() && alone() && workers::built_goes(data, id) => {
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

/// Frees `id`'s part of `group`, if it still goes, as an archive or the worker's end would have: the
/// kinds that went.
fn free(data: &Path, group: &str, id: &str) -> io::Result<Value> {
    core::check_id(id)?;
    let spec = core::load(data, id)?;
    let goes = state(data, &spec, &procs::all()).goes;
    let mut went: Vec<&str> = (goes.into_iter())
        .filter(|(_, g)| *g == group)
        .map(|(kind, _)| kind)
        .collect();
    match group {
        _ if went.is_empty() => {}
        BUILD => drop(workers::unbuilt(data, id)?),
        _ => crate::sessions::freed::again_of(data, id)?,
    }
    // What a guard kept meanwhile stays.
    went.retain(|kind| match *kind {
        "temp" => !background::tmp(&spec.dir).exists(),
        "build" => session::built(data, &spec).is_ok_and(|all| all.is_empty()),
        _ => records(&spec).is_empty(),
    });
    Ok(json!({"ok": true, "went": went}))
}
