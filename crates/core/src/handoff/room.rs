//! The room a hand-off has, and the ceiling's three steps [repo-merge D94; design rev 3 §2.6]: 80% of
//! the fresh conversation's renewal line, less what its CLI adds by itself, less the input sent after
//! the hand-off. The conversation grows whole until it would pass it; then its lines shorten, oldest
//! first, and nothing is dropped: every entry stays one `brigadier read` away.

use super::estimate::tokens;
use crate::{Spec, fold::Fold};

/// The room, in estimated tokens.
pub(super) fn room(spec: &Spec, f: &Fold, to: &str, model: Option<&str>, pending: &str) -> usize {
    let line = crate::rebirth::line_to(spec, f, to, model);
    // What this conversation's CLI added, when it's the same agent's; else the floor and a tenth
    // of the line for the project's files and tools.
    let measured = (f.context.as_ref())
        .and_then(|c| c["overhead"].as_u64())
        .filter(|_| to == crate::rebirth::backend(spec, f));
    // Else the newest any session measured for that agent in this folder.
    let known = || read(spec, to)[spec.cwd.as_str()].as_u64();
    let over = (measured.or_else(known))
        .unwrap_or_else(|| crate::adapters::overhead::floor(to) + line / 10);
    // shortcut: a pending message's attachments aren't counted; count them once images go along.
    let room = (line * 8 / 10).saturating_sub(over) as usize;
    room.saturating_sub(tokens(pending))
}

/// The newest overhead each folder measured for `backend`'s CLI, across the data folder's sessions
/// (a home the design left open: `agents/<backend>.overhead.json`).
fn store(spec: &Spec, backend: &str) -> std::path::PathBuf {
    (crate::data_of(spec).join("agents")).join(format!("{backend}.overhead.json"))
}

fn read(spec: &Spec, backend: &str) -> serde_json::Value {
    let text = std::fs::read(store(spec, backend)).unwrap_or_default();
    serde_json::from_slice(&text).unwrap_or_else(|_| serde_json::json!({}))
}

/// Keeps what the session's conversation measured its CLI adding, once its first reading is in,
/// for any session's renewal onto that agent in this folder.
pub fn remember(spec: &Spec, f: &Fold) {
    let Some(n) = f.context.as_ref().and_then(|c| c["overhead"].as_u64()) else {
        return;
    };
    let backend = crate::rebirth::backend(spec, f);
    let mut all = read(spec, backend);
    if all[spec.cwd.as_str()] == n {
        return;
    }
    all[spec.cwd.as_str()] = n.into();
    let path = store(spec, backend);
    // A lost write only leaves the floor's guess, which the redo rule puts right.
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path))
        .and_then(|_| crate::write_atomic(&path, all.to_string().as_bytes()));
}

/// A line's shape: whole, shortened (a reference alone, or the user's start and its reference),
/// a short answer with its question named only by reference, or merged into a range line.
pub(super) const WHOLE: usize = 0;
pub(super) const SHORT: usize = 1;
pub(super) const BARE: usize = 2;
pub(super) const MERGED: usize = 3;

/// Which lines the ceiling keeps as they are: the first and newest of the user's messages, and a
/// short answer with its question's context [bugfix-1112 D221], which keeps only its pair's.
#[derive(PartialEq, Clone, Copy)]
pub(super) enum Keep {
    No,
    First,
    Newest,
    Pair,
}

/// One line of the conversation, in each shape it can take.
pub(super) struct Unit {
    /// Its first and last reference, for a range line.
    pub refs: (String, String),
    pub user: bool,
    pub keep: Keep,
    /// The entries it names, for a range line's count.
    pub entries: usize,
    /// Whole, short and bare.
    pub lines: [String; 3],
    pub mode: usize,
    cost: [usize; 3],
}

impl Unit {
    pub fn new(
        refs: (String, String),
        user: bool,
        keep: Keep,
        entries: usize,
        lines: [String; 3],
    ) -> Unit {
        let cost = [0, 1, 2].map(|m| tokens(&lines[m]));
        Unit {
            refs,
            user,
            keep,
            entries,
            lines,
            mode: WHOLE,
            cost,
        }
    }

    fn cost(&self) -> usize {
        if self.mode == MERGED {
            0
        } else {
            self.cost[self.mode]
        }
    }
}

/// Shortens `units` until they fit `budget`, the room less every other section, by the three steps:
/// past `half`, every line not the user's to its reference; past the room, the user's oldest to
/// their start; then the oldest runs into range lines, and last the oldest pairs' contexts to their
/// question's reference. False when even that doesn't fit. With no budget, every line but the first
/// and newest merges: the small hand-off's.
pub(super) fn fit(
    units: &mut [Unit],
    budget: Option<(usize, usize)>,
    id: &str,
    key: impl Fn(&str) -> (u8, u64),
) -> bool {
    let Some((whole, half)) = budget else {
        for u in units
            .iter_mut()
            .filter(|u| !matches!(u.keep, Keep::First | Keep::Newest))
        {
            u.mode = MERGED;
        }
        return true;
    };
    let mut total: usize = units.iter().map(Unit::cost).sum();
    shape(
        units,
        &mut total,
        half,
        |u| !u.user && u.mode == WHOLE,
        SHORT,
    );
    shape(
        units,
        &mut total,
        whole,
        |u| u.user && u.keep == Keep::No && u.mode == WHOLE,
        SHORT,
    );
    // The oldest runs, the first message's line kept, each a range line until a kept line ends it.
    // The open run: its first and last reference, entries, the user's, and its line's cost.
    let mut run: Option<(String, String, usize, usize, usize)> = None;
    for u in units.iter_mut() {
        if total <= whole {
            return true;
        }
        if u.keep != Keep::No {
            run = None;
            continue;
        }
        let (a, b, n, k, was) = run
            .take()
            .unwrap_or_else(|| (u.refs.0.clone(), u.refs.1.clone(), 0, 0, 0));
        let a = std::cmp::min_by_key(a, u.refs.0.clone(), |r| key(r));
        let b = std::cmp::max_by_key(b, u.refs.1.clone(), |r| key(r));
        let (n, k) = (n + u.entries, k + usize::from(u.user));
        let now = tokens(&range(id, &a, &b, n, k));
        total = total - u.cost() - was + now;
        u.mode = MERGED;
        run = Some((a, b, n, k, now));
    }
    shape(units, &mut total, whole, |u| u.keep == Keep::Pair, BARE);
    total <= whole
}

/// The picked lines to `mode`, oldest first, until the total is within `until`.
fn shape(
    units: &mut [Unit],
    total: &mut usize,
    until: usize,
    pick: impl Fn(&Unit) -> bool,
    mode: usize,
) {
    for u in units.iter_mut().filter(|u| pick(u)) {
        if *total <= until {
            return;
        }
        *total = *total - u.cost() + u.cost[mode];
        u.mode = mode;
    }
}

/// The units as lines: each merged run as one range line.
pub(super) fn render(id: &str, units: &[Unit], key: impl Fn(&str) -> (u8, u64)) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < units.len() {
        if units[i].mode != MERGED {
            out += &units[i].lines[units[i].mode];
            i += 1;
            continue;
        }
        let run = units[i..].iter().take_while(|u| u.mode == MERGED).count();
        let run = &units[i..i + run];
        let a = run
            .iter()
            .map(|u| &u.refs.0)
            .min_by_key(|r| key(r))
            .cloned()
            .unwrap_or_default();
        let b = run
            .iter()
            .map(|u| &u.refs.1)
            .max_by_key(|r| key(r))
            .cloned()
            .unwrap_or_default();
        let n: usize = run.iter().map(|u| u.entries).sum();
        let k = run.iter().filter(|u| u.user).count();
        out += &range(id, &a, &b, n, k);
        i += run.len();
    }
    out
}

/// A merged run's line: its references, `n` entries, `k` of them the user's.
fn range(id: &str, a: &str, b: &str, n: usize, k: usize) -> String {
    match (a == b, n) {
        (true, 1) => format!("- {id}#{a}: 1 entry: `brigadier read {id}#{a} --around 0`\n"),
        (true, _) => format!("- {id}#{a}: {n} entries: `brigadier read {id}#{a} --around 0`\n"),
        _ => format!(
            "- {id}#{a}–{b}: {n} entries ({k} of the user's): `brigadier read {id}#{a} --to {b}`\n"
        ),
    }
}
