//! A paired device's own draft and unsent files [D51; remote design §4.3]: `--slot <device>`, which
//! only the daemon adds, last, to `draft`, `send`, `queue <id> add`, `start` and `attach` from a
//! device. Its book and files are its slot's (place.rs), under the same revision, `--took` and
//! give-back rules as the Mac's; the Mac's own draft and files are never read or written through
//! it. Sent, its files are the session's (`attachments/`), as the Mac's are.

use super::book::{self, Place, has_opt, opt, opts, unsent};
use crate::{HOME_DRAFT, USAGE, arg};
use brigadier_core::{self as core, message};
use serde_json::Value;
use std::fs;
use std::io;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};

/// A device id: 64 lower-case hex characters.
pub(crate) fn check(device: &str) -> io::Result<()> {
    let hex = |b: &u8| b.is_ascii_digit() || (b'a'..=b'f').contains(b);
    match device.len() == 64 && device.as_bytes().iter().all(hex) {
        true => Ok(()),
        false => Err(io::Error::other(format!("invalid device id {device:?}"))),
    }
}

/// Folder `dir` made if it isn't, its parent never: a deleted session's isn't made again.
pub(crate) fn made(dir: &Path) -> io::Result<PathBuf> {
    match fs::create_dir(dir) {
        Err(e) if e.kind() != io::ErrorKind::AlreadyExists => Err(e),
        _ => Ok(dir.into()),
    }
}

/// `args`, its `--slot <device>` taken off, run in that device's slot.
pub fn run(data: &Path, args: &[String], device: &str) -> io::Result<Value> {
    check(device)?;
    let d = Some(device);
    let session = || -> io::Result<Place> {
        let dir = core::load(data, arg(args, 1)?)?.dir;
        made(&dir.join("drafts"))?;
        Ok(Place::Session(dir, d.map(String::from)))
    };
    match arg(args, 0)? {
        "draft" if matches!(arg(args, 2), Ok("retry" | "adopt" | "drop")) => {
            let place = super::place(data, arg(args, 1)?, d)?;
            book::ops(&place, args, |a| match a[0].as_str() {
                "send" => lent(data, &place, a, |a| crate::send(data, a)),
                "start" => lent(data, &place, a, |a| crate::start::start(data, a)),
                _ => lent(data, &place, a, |a| crate::queue::run(data, a)),
            })
        }
        "draft" => super::kept(data, args, d),
        "send" => {
            let place = session()?;
            book::going(&place, args, |a| {
                lent(data, &place, a, |a| crate::send(data, a))
            })
        }
        "queue" if matches!(arg(args, 2), Ok("add")) => {
            let place = session()?;
            book::going(&place, args, |a| {
                lent(data, &place, a, |a| crate::queue::run(data, a))
            })
        }
        // A device's new chat goes through its Home book, as the Mac's `--home` does; kept there
        // always, as one not kept undoes itself into the Mac's Home [C65].
        "start" => {
            let o = opts(args);
            // Home's book is named by the daemon's slot alone.
            if has_opt(o, "--home") {
                return Err(io::Error::other(USAGE));
            }
            if opt(o, "--draft").is_none() || opt(o, "--cid").is_none() {
                return Err(io::Error::other(
                    "A device's new chat carries its draft and its id.",
                ));
            }
            let key =
                opt(o, "--project").map_or(HOME_DRAFT.to_string(), |p| format!("{HOME_DRAFT}:{p}"));
            let place = super::place(data, &key, d)?;
            let args = [args, &["--home".into(), key]].concat();
            book::going(&place, &args, |a| {
                lent(data, &place, a, |a| crate::start::start(data, a))
            })
        }
        "attach" => super::run(data, args, d),
        _ => Err(io::Error::other(USAGE)),
    }
}

/// Message `args`' files in `place`'s own folder moved into its session's `attachments/` before it
/// runs, where `take` finds them taken already: `take` moves only the Mac's. One the Mac's draft
/// or Home's holds is refused, never taken. They come back if it surely never went: refused before
/// any host, or a new chat whose session was never made; else a give-back brings them (place.rs).
fn lent(
    data: &Path,
    place: &Place,
    args: &[String],
    run: impl FnOnce(&[String]) -> io::Result<Value>,
) -> io::Result<Value> {
    let o = opts(args);
    let parts: Value = opt(o, "--parts").map_or(Ok(Value::Null), serde_json::from_str)?;
    let to = core::session_dir(data, arg(args, 1)?);
    let (own, sent) = (place.unsent(), message::sent(&to));
    let refuse = |why: &str| Err(unsent(io::Error::other(why.to_string())));
    if has_opt(o, "--from") {
        return refuse("A device's message takes only its own files.");
    }
    let mut moved = vec![];
    // Every file `take` would take, a note's kept copies too.
    for id in message::ids(&parts)
        .into_iter()
        .chain(message::notes::kept(&parts))
    {
        if message::file_in(&sent, &id).is_some() {
            continue;
        }
        let mac = [message::draft(&to), message::home(data)];
        if message::file_in(&own, &id).is_none() {
            if mac.iter().any(|f| message::file_in(f, &id).is_some()) {
                give_back(&own, &sent, &moved);
                return refuse("This file isn't one of this draft's.");
            }
            continue;
        }
        // A new chat's folder, made as `core::create` makes it.
        let step = fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&to)
            .and_then(|()| fs::create_dir_all(&sent))
            .and_then(|()| fs::rename(own.join(&id), sent.join(&id)));
        if let Err(e) = step {
            give_back(&own, &sent, &moved);
            return Err(unsent(e));
        }
        moved.push(id);
    }
    let out = run(args);
    let never = !to.join("session.json").exists();
    // A queue add that left nothing never went, booked or not (one for a worker isn't).
    let ok = out.as_ref().is_ok_and(|r| r["ok"] == true);
    let qid = (args[0] == "queue").then(|| opt(o, "--qid")).flatten();
    let left = qid.is_some_and(|q| !ok && !book::present(&to, q));
    if never || left || out.as_ref().is_err_and(book::is_unsent) {
        give_back(&own, &sent, &moved);
    }
    if never {
        // shortcut: a crash between the move and the start leaves them here, found by a retry
        // but lost to a Discard; carry them back in `place::undo` if that's ever seen.
        let _ = fs::remove_dir(&sent).and_then(|()| fs::remove_dir(&to));
    }
    out
}

/// Files `ids` back from `sent` into `own`; one that can't go stays, as `take`'s undo leaves it.
fn give_back(own: &Path, sent: &Path, ids: &[String]) {
    for id in ids.iter().rev() {
        let back = fs::create_dir_all(own).and_then(|()| fs::rename(sent.join(id), own.join(id)));
        if let Err(why) = back {
            eprintln!("slot: {id} stays in attachments: {why}");
        }
    }
}

/// Each device's Home files none of its Home drafts names, once a day old, by `sweep_home`'s rule:
/// what its saved words, its messages on their way and its give-backs name stays.
pub(crate) fn sweep(data: &Path) {
    let drafts = data.join("drafts");
    let day = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 60 * 60);
    for folder in fs::read_dir(&drafts).into_iter().flatten().flatten() {
        let name = folder.file_name().to_string_lossy().into_owned();
        let Some(device) = name
            .strip_suffix("-attachments")
            .filter(|d| check(d).is_ok())
        else {
            continue;
        };
        let books = fs::read_dir(&drafts).into_iter().flatten().flatten();
        let books = books.filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(&format!("home-{device}"))
        });
        let mut named = vec![];
        for saved in
            books.filter_map(|e| serde_json::from_slice::<Value>(&fs::read(e.path()).ok()?).ok())
        {
            let book = &saved["book"];
            let each = ["inflight", "adding", "given"]
                .map(|k| book[k].as_array().cloned().unwrap_or_default());
            let typed = each[2].iter().map(|g| g["typed"].clone()).collect();
            for words in [vec![saved.clone()], typed]
                .into_iter()
                .chain(each)
                .flatten()
            {
                named.extend(message::ids(&words));
            }
        }
        for entry in fs::read_dir(folder.path()).into_iter().flatten().flatten() {
            let old = (entry.metadata().and_then(|m| m.modified())).is_ok_and(|at| at < day);
            if old && !named.iter().any(|n| entry.file_name() == n.as_str()) {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
}

/// A revoked device's every slot, book, lock and unsent file, in each session and Home's [D51].
pub fn forget_device(data: &Path, device: &str) -> io::Result<()> {
    check(device)?;
    let sessions = fs::read_dir(data.join("sessions"))
        .into_iter()
        .flatten()
        .flatten();
    let folders = sessions
        .map(|s| s.path().join("drafts"))
        .chain([data.join("drafts")]);
    for folder in folders {
        for entry in fs::read_dir(&folder).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name
                .strip_prefix("home-")
                .unwrap_or(&name)
                .starts_with(device)
            {
                continue;
            }
            match entry.file_type()?.is_dir() {
                true => fs::remove_dir_all(entry.path())?,
                false => fs::remove_file(entry.path())?,
            }
        }
    }
    Ok(())
}
