//! The open apps among processes: a .app bundle's own process with a window on the screen, which
//! a headless or hidden one never has. Its helpers are inside it.

use brigadier_frames::procs::{self, Proc};
use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relative: u32) -> CFArrayRef;
}

/// How long one read of the screen's windows serves the index's pass over all sessions.
const WINDOWS_FOR: Duration = Duration::from_millis(400);

/// The processes with a window on the screen when last read, and each one ever seen with one: an app
/// stays open while it's minimised, hidden or in another Space.
/// shortcut: one opened before this daemon started shows once its window is on the screen again.
#[derive(Default)]
struct Seen {
    at: Option<Instant>,
    now: HashSet<i32>,
    ever: HashSet<(i32, u64)>,
}

static SEEN: Mutex<Option<Seen>> = Mutex::new(None);

/// The open apps in a job's tree, each by its name.
pub fn open(tree: &[Proc]) -> Vec<(Proc, String)> {
    let apps: Vec<(&Proc, String)> = (tree.iter())
        .filter_map(|p| Some((p, name(p.pid)?)))
        .filter(|(p, _)| shown(p))
        .collect();
    // One another started is inside it.
    let below = |p: &Proc| {
        (apps.iter()).any(|(a, _)| (procs::descendants(tree, a.pid).iter()).any(|d| d.pid == p.pid))
    };
    (apps.iter())
        .filter(|(p, _)| !below(p))
        .map(|(p, name)| (**p, name.clone()))
        .collect()
}

/// The bundle a process is the main one of, by its name; a helper's is inside its app's.
fn name(pid: i32) -> Option<String> {
    let exe = procs::exe(pid)?;
    let bundle = (exe.ancestors().skip(1))
        .filter(|d| d.extension().is_some_and(|e| e == "app"))
        .last()?;
    let main = exe.parent() == Some(&bundle.join("Contents/MacOS"));
    main.then(|| bundle.file_stem())?
        .map(|n| n.to_string_lossy().into())
}

fn shown(p: &Proc) -> bool {
    let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    let seen = seen.get_or_insert_default();
    let key = (p.pid, p.start_us);
    if seen.ever.contains(&key) {
        return true;
    }
    if seen.at.is_none_or(|at| at.elapsed() >= WINDOWS_FOR) {
        seen.now = on_screen();
        seen.at = Some(Instant::now());
        seen.ever
            .retain(|(pid, start)| procs::same(*pid, *start).is_some());
    }
    seen.now.contains(&p.pid) && seen.ever.insert(key)
}

/// The processes with an ordinary window on the screen that isn't wholly clear.
fn on_screen() -> HashSet<i32> {
    // kCGWindowListOptionOnScreenOnly, kCGNullWindowID.
    let list = unsafe { CGWindowListCopyWindowInfo(1, 0) };
    if list.is_null() {
        return HashSet::new();
    }
    let list: CFArray<CFDictionary<CFString, CFType>> =
        unsafe { CFArray::wrap_under_create_rule(list) };
    (list.iter())
        .filter_map(|w| {
            let of = |key: &'static str| {
                w.find(CFString::from_static_string(key))?
                    .downcast::<CFNumber>()?
                    .to_f64()
            };
            let ordinary = of("kCGWindowLayer")? == 0.0 && of("kCGWindowAlpha")? > 0.0;
            ordinary.then(|| of("kCGWindowOwnerPID")).flatten()
        })
        .map(|pid| pid as i32)
        .collect()
}
