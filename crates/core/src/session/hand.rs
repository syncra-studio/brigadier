//! Delete of a session others share a worktree with: the worktree goes on to one of them.

use super::{ARCHIVED, guarded, holder, record, sharers};
use crate::{Spec, data_of, share, worktrees, worktrees::lost::Guard};
use serde_json::Value;
use std::io;
use std::path::Path;

/// While others use the folder, its worktree's record goes to one of them; a folder chat's claims
/// each the same way [D1080].
pub(super) fn hand_on(spec: &Spec, intent: &mut Value) -> io::Result<()> {
    let may = guarded(spec, Guard::Named);
    {
        let (others, _held) = sharers(spec)?;
        // A user with no record leaving only archived ones: the holder's worktree is freed [D180].
        if worktrees::made(&spec.dir) {
            hand(spec, &spec.dir, None, &others, intent)?;
        } else if !others.is_empty() && others.iter().all(|o| o.dir.join(ARCHIVED).exists()) {
            let holder = holder(spec, &others);
            if may(&holder) {
                worktrees::free(&holder)?;
            }
        }
    }
    let data = data_of(spec);
    for (name, rec) in crate::folder::claims(&spec.dir) {
        let Some(folder) = worktrees::folder(&rec) else {
            continue;
        };
        if share::in_folder(&data, &folder, Some(&spec.id)).is_empty() {
            continue;
        }
        let _one = worktrees::lock(&rec)?;
        let _held = crate::rewind::checkout_lock(&data, true)?;
        let others = share::in_folder(&data, &folder, Some(&spec.id));
        hand(spec, &rec, Some(&name), &others, intent)?;
    }
    Ok(())
}

/// The record `rec`, the session's own or claim `name`'s, goes to the oldest of `others` not being
/// deleted itself, landing with it [D1080, D1082], named in the intent first so a crash finishes the
/// same handover [D35]. Only users left archived: the worktree is freed, as the last archive would,
/// unless a repository inside keeps it [D180].
fn hand(
    spec: &Spec,
    rec: &Path,
    name: Option<&str>,
    others: &[Spec],
    intent: &mut Value,
) -> io::Result<()> {
    let deleting = |o: &Spec| super::intent(&o.dir).is_some_and(|i| i["op"] == "delete");
    let slot = match name {
        None => &mut intent["heir"],
        Some(name) => &mut intent["heirs"][name],
    };
    let Some(heir) = (others.iter())
        .find(|o| slot.as_str() == Some(&o.id))
        .or_else(|| others.iter().find(|o| !deleting(o)))
    else {
        return Ok(());
    };
    *slot = heir.id.clone().into();
    record(&spec.dir, intent)?;
    worktrees::handover(rec, &heir.dir)?;
    let archived = others.iter().all(|o| o.dir.join(ARCHIVED).exists());
    if archived && guarded(spec, Guard::Named)(&heir.dir) {
        worktrees::free(&heir.dir)?;
    }
    Ok(())
}
