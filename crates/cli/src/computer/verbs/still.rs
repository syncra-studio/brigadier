//! The level and the yes once more, as a call leaves for an app [D31]: it may have waited since they
//! were checked, for the user to leave its app [D910], the helper or its cursor.

use super::asks::{allowed, level, shut};
use super::refuse;
use serde_json::Value;
use std::cell::RefCell;
use std::path::{Path, PathBuf};

const CHANGED: &str = "What you may use changed meanwhile, so this wasn't sent: make the same call again, and the user is asked where they must be.";

/// The agent's call this thread serves, and whether it was past Ask when last checked.
struct Caller {
    data: PathBuf,
    me: String,
    past: bool,
}

thread_local! {
    static CALLER: RefCell<Option<Caller>> = const { RefCell::new(None) };
}

pub(super) fn begin(data: &Path, me: &str) {
    let (data, me) = (data.into(), me.into());
    let past = false;
    CALLER.set(Some(Caller { data, me, past }));
}

pub(super) fn checked(past: bool) {
    CALLER.with_borrow_mut(|c| {
        if let Some(c) = c {
            c.past = past;
        }
    });
}

/// Why a call with `args` doesn't go to its app now. One begun past Ask was never held to Ask's own
/// refusals, so a yes it finds isn't enough. A list of windows goes: it finds the app to ask about.
pub(in crate::computer) fn closed(name: &str, args: &Value) -> Option<String> {
    let pid = args["pid"].as_i64().filter(|_| name != "list_windows")?;
    let no = CALLER.with_borrow(|c| {
        c.as_ref()
            .is_some_and(|c| shut(&c.data, &c.me, pid) || (c.past && level(&c.data, &c.me).0))
    });
    no.then(|| CHANGED.into())
}

/// Puts back what this call itself cleared, whatever changed since: the user's own text is at stake.
pub(super) fn undo<T>(f: impl FnOnce() -> T) -> T {
    let caller = CALLER.take();
    let done = f();
    CALLER.set(caller);
    done
}

/// Whether `open` may still start what it checked: the app asked about, or `None` past Ask.
pub(super) fn start(data: &Path, me: &str, asked: Option<&Path>) -> Result<(), Value> {
    let chat = crate::workers::place(data, me).0;
    match level(data, me).0 && !asked.is_some_and(|app| allowed(data, &chat, app)) {
        true => Err(refuse(CHANGED)),
        false => Ok(()),
    }
}
