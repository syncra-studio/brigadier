//! Review's Last turn [D1000, D1035, D1192]: what the session's last turn changed, or a whole night
//! (Overnight), read from the captures rewind already takes of its folder, in the
//! session's own `sessions/<id>/rewind.git` [D35]. A turn still running, or one whose end
//! capture was missed, compares its start with the folder now and says so: that one capture is
//! written to the store, under the session's fence. Nothing in the folder changes: no stage or
//! revert, like Branch since base [D1001].

use super::diff::{Patch, SIDE_MAX, binary, ids_in, shape, text};
use super::listed::{listed, review_of};
use super::{Checkout, err};
use crate::fold::Fold;
use crate::rewind::{Shot, Store};
use crate::{Spec, folder};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::{fs, io};

/// Two captures, the last turn's or a night's, or why there are none: `noProject`, `noTurn`, `midTurn` (sent
/// while another turn ran), `noNight` or `noSnapshot` [D30]; or `busy`: the folder now couldn't be captured
/// at once, so the app keeps what it drew and asks again.
pub struct Last {
    /// The scope it was asked as.
    name: String,
    store: Store,
    before: Shot,
    after: Shot,
    /// The turn is still running: its start against now.
    live: bool,
    /// Its end capture was missed: its start against now.
    missed: bool,
    /// The captured folder's place in the checkout, so paths are the checkout's.
    prefix: String,
}

fn prefix(store: &Store, checkout: &Checkout) -> String {
    let rel = store
        .cwd()
        .strip_prefix(&checkout.root)
        .unwrap_or(Path::new(""));
    let rel = rel.to_string_lossy();
    if rel.is_empty() {
        String::new()
    } else {
        format!("{rel}/")
    }
}

pub fn of(spec: &Spec, f: &Fold, checkout: &Checkout) -> Result<Last, &'static str> {
    let store = Store::of(spec).ok_or("noProject")?;
    let (id, live, mid) = match f.turns.first() {
        Some(turn) => (turn.id.clone(), true, turn.mid),
        None => {
            let last = f.last.as_ref().ok_or("noTurn")?;
            let id = last["id"].as_str().unwrap_or_default().to_string();
            let mid = (f.boundaries.iter()).any(|b| b.cid == id && !b.whole);
            (id, false, mid)
        }
    };
    let record = store
        .load(&id)
        .ok_or(if mid { "midTurn" } else { "noSnapshot" })?;
    let (after, missed) = match record.end.filter(|_| !live) {
        Some(end) => (end, false),
        None => (now(spec, &store)?, !live),
    };
    let prefix = prefix(&store, checkout);
    Ok(Last {
        name: "last".into(),
        store,
        before: record.before,
        after,
        live,
        missed,
        prefix,
    })
}

/// A finished night's, between its own two captures (`rewind::night_starts`): what was there before
/// Start night, commits and uncommitted edits, and what came after it ended stay out. Each repo a
/// folder chat claimed has its own, its paths `<repo>/<path>`.
pub fn night(
    spec: &Spec,
    checkout: Option<&Checkout>,
    name: &str,
    since: u64,
) -> Result<Vec<Last>, &'static str> {
    let stores: Vec<(Store, String)> = match checkout {
        Some(checkout) => {
            let store = Store::of(spec).ok_or("noProject")?;
            let prefix = prefix(&store, checkout);
            vec![(store, prefix)]
        }
        None => (folder::claims(&spec.dir).into_iter())
            .filter_map(|(name, rec)| Some((Store::claim(&rec)?, format!("{name}/"))))
            .collect(),
    };
    let nights: Vec<Last> = (stores.into_iter())
        .filter_map(|(store, prefix)| {
            let record = store.night(since)?;
            Some(Last {
                name: name.into(),
                before: record.before,
                after: record.end?,
                store,
                live: false,
                missed: false,
                prefix,
            })
        })
        .collect();
    match nights.is_empty() {
        true => Err("noNight"),
        false => Ok(nights),
    }
}

/// The folder now, under the session's fence, tried and never waited for: a delete, a closing
/// session or a turn starting goes first, and no capture lands in a folder being removed [D35].
fn now(spec: &Spec, store: &Store) -> Result<Shot, &'static str> {
    if crate::session::closed(&spec.dir).is_some() {
        return Err("busy");
    }
    let fence = fs::OpenOptions::new()
        .write(true)
        .open(spec.dir.join("worktree.lock"))
        .map_err(|_| "busy")?;
    fence.try_lock().map_err(|_| "busy")?;
    if crate::session::closed(&spec.dir).is_some() {
        return Err("busy");
    }
    store.capture().map_err(|_| "noSnapshot")
}

fn diff(store: &Store, before: &str, after: &str, extra: &[&str]) -> io::Result<Vec<u8>> {
    let mut args = vec![
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "-M",
        before,
        after,
    ];
    args.extend(extra);
    store.read(&args)
}

/// A tree id as a capture wrote it: what the UI hands back is checked before git reads it.
fn tree(store: &Store, id: &str) -> io::Result<()> {
    let ok = id.len() >= 40 && id.bytes().all(|b| b.is_ascii_hexdigit());
    if !ok
        || !store
            .read(&["cat-file", "-t", id])
            .is_ok_and(|t| t.trim_ascii() == b"tree")
    {
        return err(format!("no capture {id:?}"));
    }
    Ok(())
}

impl Last {
    fn files(&self) -> io::Result<BTreeMap<String, Value>> {
        let (a, b) = (&self.before.tree, &self.after.tree);
        let names = diff(&self.store, a, b, &["--name-status", "-z"])?;
        let counts = diff(&self.store, a, b, &["--numstat", "-z"])?;
        Ok(listed(&names, &counts, false)
            .into_iter()
            .map(|(path, mut file)| {
                let at = |v: &Value| v.as_str().map(|p| format!("{}{p}", self.prefix));
                (file["path"], file["from"]) = (at(&file["path"]).into(), at(&file["from"]).into());
                (format!("{}{path}", self.prefix), file)
            })
            .collect())
    }
}

/// Review's list for the turn [D1036], with `turn`: the two trees `file` takes back, whether it
/// compares with now, and what the captures leave out [D1192]. Files the project ignores are never
/// in a capture; the UI says so in general, never which. `parts`: the turn, or a night's folders.
pub fn list(parts: &[Last]) -> io::Result<Value> {
    let Some(first) = parts.first() else {
        return err("nothing to compare");
    };
    let mut files = BTreeMap::new();
    let mut excluded = BTreeSet::new();
    for part in parts {
        files.append(&mut part.files()?);
        let out = part.before.out.keys().chain(part.after.out.keys());
        excluded.extend(out.map(|p| format!("{}{p}", part.prefix)));
    }
    let mut review = review_of(&first.name, files);
    review["turn"] = json!({"before": first.before.tree, "after": first.after.tree,
        "live": first.live, "missed": first.missed, "excluded": excluded});
    Ok(review)
}

/// One file of a finished night's, as `file` gives a turn's: its captures stay, so it names none.
pub fn night_file(parts: &[Last], path: &str, from: Option<&str>) -> io::Result<Value> {
    let Some(part) = parts.iter().find(|p| path.starts_with(&p.prefix)) else {
        return err(format!("{path:?} isn't in this night"));
    };
    let trees = (part.before.tree.as_str(), part.after.tree.as_str());
    contents(&part.store, &part.prefix, trees, path, from)
}

/// One file of the turn between two trees `list` gave: `{before, after, hunks}` or `{error}`.
pub fn file(
    spec: &Spec,
    checkout: &Checkout,
    trees: (&str, &str),
    path: &str,
    from: Option<&str>,
) -> io::Result<Value> {
    let Some(store) = Store::of(spec) else {
        return err("This session has no snapshots.");
    };
    tree(&store, trees.0)?;
    tree(&store, trees.1)?;
    contents(&store, &prefix(&store, checkout), trees, path, from)
}

fn contents(
    store: &Store,
    prefix: &str,
    trees: (&str, &str),
    path: &str,
    from: Option<&str>,
) -> io::Result<Value> {
    let rel = |p: &str| -> io::Result<String> {
        let rel = p.strip_prefix(prefix).unwrap_or(p);
        if rel.is_empty() || rel.split('/').any(|part| part == ".." || part.is_empty()) {
            return err(format!("{p:?} isn't in this turn's folder"));
        }
        Ok(rel.to_string())
    };
    let (path_in, from_in) = (rel(path)?, from.map(rel).transpose()?);
    let side = |tree: &str, p: &str| -> io::Result<Result<String, String>> {
        let spec = format!("{tree}:{p}");
        let Ok(size) = store.read(&["cat-file", "-s", &spec]) else {
            return Ok(Ok(String::new()));
        };
        let size: u64 = String::from_utf8_lossy(&size).trim().parse().unwrap_or(0);
        if size > SIDE_MAX {
            return Ok(Err("This file is too big to show here.".into()));
        }
        let bytes = store.read(&["cat-file", "blob", &spec])?;
        Ok(match binary(&bytes) {
            true => Err("This file is binary.".into()),
            false => Ok(text(bytes)),
        })
    };
    let old = from_in.as_deref().unwrap_or(&path_in);
    let (before, after) = match (side(trees.0, old)?, side(trees.1, &path_in)?) {
        (Ok(before), Ok(after)) => (before, after),
        (Err(why), _) | (_, Err(why)) => return Ok(json!({"error": why})),
    };
    let mut args = vec!["-U3", "--"];
    args.extend(from_in.as_deref());
    args.push(&path_in);
    let patch = Patch::parse(&diff(store, trees.0, trees.1, &args)?);
    let ids = ids_in("last", path, &patch.hunks);
    let hunks: Vec<Value> = (patch.hunks.iter().zip(ids))
        .map(|(hunk, id)| shape(hunk, id, false))
        .collect();
    Ok(json!({"before": before, "after": after, "hunks": hunks}))
}
