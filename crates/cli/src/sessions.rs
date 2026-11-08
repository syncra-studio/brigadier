//! Archive, restore and delete [D35, D180, D181, D198]: the session's host stops first, then
//! core does the work under the session's lock. Each answers the folder's time after its marks,
//! so the row that shows it has `touched` as late.

use crate::{arg, has, index, owner};
use brigadier_core::{self as core, session};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = arg(args, 1)?;
    let spec = core::load(data, id)?;
    let stop = || {
        let _ = owner::call(data, id, json!({"op": "stop", "by": args[0]}));
        owner::release(data, id)
    };
    match args[0].as_str() {
        "archive" => session::archive(&spec, || {
            let _ = stop();
        })?,
        "restore" => session::restore(data, &spec)?,
        // Proposed: `--check` names the branch the confirm asks about [D181].
        _ if has(args, "--check") => {
            return Ok(json!({"ok": true, "branch": session::unlanded(&spec)?}));
        }
        _ => {
            stop()?;
            let f = core::fold(&spec.dir, false)?;
            let drop = crate::flag(args, "--branch") == Some("delete");
            return Ok(session::delete(&spec, &f.fold, drop));
        }
    }
    Ok(json!({"ok": true, "at": index::touched(&spec.dir)}))
}
