//! Review's Last turn [D1000, D1035, D1192]: what the session's last turn changed, read from the
//! two captures rewind already takes of its folder, in the session's own `sessions/<id>/rewind.git`
//! [D35]. A turn still running, or one whose end capture was missed, compares its start with the
//! folder now and says so: that one capture is written to the store, under the session's fence.
//! Nothing in the folder changes: no stage or revert, like Branch since base [D1001].

use super::diff::{Patch, SIDE_MAX, binary, ids_in, shape, text};
use super::listed::{listed, review_of};
use super::{Checkout, err};
use crate::Spec;
use crate::fold::Fold;
use crate::rewind::{Shot, Store};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::Path;
use std::{fs, io};

const NAME: &str = "last";

/// The last turn's two moments, or why there are none: `noProject`, `noTurn`, `midTurn` (sent
/// while another turn ran) or `noSnapshot` [D30]; or `busy`: the folder now couldn't be captured
/// at once, so the app keeps what it drew and asks again.
pub struct Last {
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
        store,
        before: record.before,
        after,
        live,
        missed,
        prefix,
    })
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
    /// Review's list for the turn [D1036], with `turn`: the two trees `file` takes back, whether
    /// it compares with now, and what the captures leave out [D1192]. Files the project ignores are
    /// never in a capture; the UI says so in general, never which.
    pub fn list(&self) -> io::Result<Value> {
        let (a, b) = (&self.before.tree, &self.after.tree);
        let names = diff(&self.store, a, b, &["--name-status", "-z"])?;
        let counts = diff(&self.store, a, b, &["--numstat", "-z"])?;
        let files = listed(&names, &counts, false)
            .into_iter()
            .map(|(path, mut file)| {
                let at = |v: &Value| v.as_str().map(|p| format!("{}{p}", self.prefix));
                (file["path"], file["from"]) = (at(&file["path"]).into(), at(&file["from"]).into());
                (format!("{}{path}", self.prefix), file)
            })
            .collect();
        let mut review = review_of(NAME, files);
        let excluded: BTreeSet<String> = (self.before.out.keys().chain(self.after.out.keys()))
            .map(|p| format!("{}{p}", self.prefix))
            .collect();
        review["turn"] = json!({"before": a, "after": b, "live": self.live, "missed": self.missed,
                                "excluded": excluded});
        Ok(review)
    }
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
    let prefix = prefix(&store, checkout);
    let rel = |p: &str| -> io::Result<String> {
        let rel = p.strip_prefix(prefix.as_str()).unwrap_or(p);
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
    let patch = Patch::parse(&diff(&store, trees.0, trees.1, &args)?);
    let ids = ids_in(NAME, path, &patch.hunks);
    let hunks: Vec<Value> = (patch.hunks.iter().zip(ids))
        .map(|(hunk, id)| shape(hunk, id, false))
        .collect();
    Ok(json!({"before": before, "after": after, "hunks": hunks}))
}
