//! A session's fold kept between reads: in this process, and for others in its checkpoint. Both are
//! only caches: losing them changes nothing but speed.

use crate::{Folded, fold_from, write_atomic};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const CHECKPOINT_EVERY: u64 = 16 << 20;

/// A session's last clean fold, its log's inode, and how far its checkpoint had got.
struct Kept {
    log: u64,
    saved: u64,
    fold: Folded,
}

// shortcut: a deleted session's stays until the process ends, about 40 KB each; drop it on delete
// if a daemon's memory shows it.
static KEPT: Mutex<BTreeMap<PathBuf, Kept>> = Mutex::new(BTreeMap::new());

/// Keeps a clean fold made elsewhere (the index's), unless one as far is kept.
pub fn keep(dir: &Path, fold: &Folded) {
    let Ok(log) = fs::metadata(dir.join("log")).map(|m| m.ino()) else {
        return;
    };
    let mut kept = KEPT.lock().unwrap();
    let was = kept.get(dir).filter(|k| k.log == log);
    if was.is_some_and(|k| k.fold.pos >= fold.pos) {
        return;
    }
    let (saved, fold) = (was.map_or(0, |k| k.saved), fold.clone());
    kept.insert(dir.into(), Kept { log, saved, fold });
}

/// Folds the whole log, carrying on from this process's last fold of it, else from the checkpoint
/// when one is valid, and writes a new one when the log grew a lot.
pub fn fold(dir: &Path, use_checkpoint: bool) -> io::Result<Folded> {
    if !use_checkpoint {
        return fold_from(dir, Folded::default(), |_| {});
    }
    let ckpt = dir.join("fold.json");
    let (log, len) = fs::metadata(dir.join("log")).map_or((0, 0), |m| (m.ino(), m.len()));
    let kept = (KEPT.lock().unwrap().get(dir))
        .filter(|k| k.log == log && k.fold.pos <= len)
        .map(|k| (k.saved, k.fold.clone()));
    let (mut saved, f) = kept.unwrap_or_else(|| {
        let f = (fs::read(&ckpt).ok())
            .and_then(|b| serde_json::from_slice::<Folded>(&b).ok())
            .filter(|f| f.v == crate::FOLDED && f.pos <= len)
            .unwrap_or_default();
        (f.pos, f)
    });
    let f = fold_from(dir, f, |_| {})?;
    // Only a fold that ended clean has its state and offset at the same frame.
    if f.norm.clean() {
        if f.pos - saved >= CHECKPOINT_EVERY {
            let _ = write_atomic(&ckpt, &serde_json::to_vec(&f)?);
            saved = f.pos;
        }
        let fold = f.clone();
        (KEPT.lock().unwrap()).insert(dir.into(), Kept { log, saved, fold });
    }
    Ok(f)
}
