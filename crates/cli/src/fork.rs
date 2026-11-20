//! `fork <id> --check <cid>`: what the Fork menu offers on an answer, `--latest` on its latest; `fork <id> <new-id> --at <cid>
//! [--where worktree|here|chat] [--fingerprint F] [--to B --model M [--effort E] [--fast]]`: the
//! fork, on agent B's model M (on its fast tier with `--fast`) when picked [D1081], settled and fenced on the answer's source
//! [D1063, D1089]. Run again under the same ids, it finishes or rolls back what its record proves.

use crate::{USAGE, arg, flag, has, owner, rewind, title};
use brigadier_core::fork::{self, Ask};
use brigadier_core::{self as core, check_id};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let spec = core::load(data, arg(args, 1)?)?;
    if let Some(at) = flag(args, "--check") {
        check_id(at)?;
        let s = fork::source(data, &spec, at)?;
        return Ok(fork::offer(data, &spec, &s, at));
    }
    // `fork <id> --latest`: the same check on its latest answer, named in `at` [D3105].
    if has(args, "--latest") {
        let Some(at) = fork::latest(&spec) else {
            return Ok(
                json!({"ok": false, "error": "none", "message": "No answer to fork from yet."}),
            );
        };
        let mut offer = fork::offer(data, &spec, &fork::source(data, &spec, &at)?, &at);
        offer["at"] = at.into();
        return Ok(offer);
    }
    let new = arg(args, 2)?;
    let at = flag(args, "--at").ok_or_else(|| io::Error::other(USAGE))?;
    check_id(new)?;
    check_id(at)?;
    let mut s = fork::source(data, &spec, at)?;
    // The fork's start is checked against the rules, as every launch is [D376].
    s.src.rules = Some(crate::routing::launch);
    // A fork cut short, this one's earlier try too, finishes or rolls back first [D54].
    rewind::settled(data, &s.src)?;
    if fork::record(&core::session_dir(data, new)).is_some() {
        return Ok(json!({"ok": true, "session": new}));
    }
    let named = fs::read_to_string(s.src.dir.join("title")).ok();
    let named = named.filter(|t| !t.is_empty()).unwrap_or_else(|| {
        let mut first = String::new();
        let _ = core::read(&s.src.dir, |item| {
            if first.is_empty() && item["kind"] == "input" && item["origin"] == "user" {
                first = title::from(item["text"].as_str().unwrap_or(""));
            }
        });
        first
    });
    let call_in = |id: &str, req: Value| {
        owner::ensure(data, &core::load(data, id)?)?;
        owner::call(data, id, req)
    };
    let ask = Ask {
        fork: new,
        title: &format!("Fork of {named}"),
        at,
        place: flag(args, "--where"),
        fingerprint: flag(args, "--fingerprint"),
        to: match (flag(args, "--to"), flag(args, "--model")) {
            (Some(b), Some(m)) => Some((b, m, flag(args, "--effort"), has(args, "--fast"))),
            (None, None) => None,
            _ => return Err(io::Error::other(USAGE)),
        },
    };
    fork::fork(data, &spec, &s, &ask, &call_in)
}
