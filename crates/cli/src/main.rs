//! `brigadier`: the one way in for every client and every drill. Each command prints one JSON line.

mod owner;

use brigadier_core::fold::{self, Owner};
use brigadier_core::{self as core, Spec, adapters};
use brigadier_frames::{log, procs};
use serde_json::{Value, json};
use std::io::{self, Write};
use std::path::Path;
use std::time::{Duration, Instant};
use std::{env, process, thread};

const USAGE: &str = "usage: brigadier start <id> --backend B [--mode pipe|pty] [--cwd D] [--model M] [--opt K=V] [--text T]
       brigadier send <id> <text> [--cid C] [--backend B]
       brigadier status [<id>...|--all]
       brigadier stop <id> | recover <id> | delete <id> | owner <id> | up <id>...
       brigadier read <id> [--follow] [--hash] [--tail N]
       brigadier index [--cold] | transcript <id>";

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let data = core::data_dir();
    let out = match run(&data, &args) {
        Ok(v) => v,
        Err(e) => json!({"ok": false, "error": e.to_string()}),
    };
    if !out.is_null() {
        println!("{out}");
    }
    process::exit(if out["ok"] == false { 1 } else { 0 });
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn arg(args: &[String], i: usize) -> io::Result<&str> {
    args.get(i)
        .map(String::as_str)
        .ok_or_else(|| io::Error::other(USAGE))
}

fn call_fn<'a>(data: &'a Path, id: &'a str) -> impl Fn(Value) -> io::Result<Value> + 'a {
    move |req| owner::call(data, id, req)
}

/// The child pid the owner holds right now, if any. An owner that doesn't answer reads as none.
fn child(data: &Path, id: &str) -> Option<i32> {
    owner::call(data, id, json!({"op": "ping"}))
        .ok()
        .and_then(|v| v["child"].as_i64())
        .map(|p| p as i32)
}

fn status_of(data: &Path, id: &str, all: &[procs::Proc]) -> io::Result<Value> {
    let dir = core::session_dir(data, id);
    let f = core::fold(&dir, true)?;
    let live = fold::live(&f.fold, owner::state(data, id), data, all);
    let mut s = fold::status(&f.fold, &live);
    s["id"] = id.into();
    Ok(s)
}

fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let cmd = args.first().map(String::as_str).unwrap_or("");
    // Every session id this command names, checked before any path is built from it.
    let ids = match cmd {
        "status" | "up" => &args[1..],
        "index" => &[][..],
        _ => &args[1.min(args.len())..2.min(args.len())],
    };
    for id in ids.iter().filter(|a| *a != "--all") {
        core::check_id(id)?;
    }
    match cmd {
        "start" => {
            let id = arg(args, 1)?;
            let backend = flag(args, "--backend").unwrap_or("fake");
            if adapters::get(backend).is_none() {
                return Err(io::Error::other(format!("unknown backend {backend}")));
            }
            let opts = args
                .windows(2)
                .filter(|w| w[0] == "--opt")
                .filter_map(|w| w[1].split_once('='))
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            let cwd = flag(args, "--cwd")
                .map(String::from)
                .unwrap_or_else(|| env::current_dir().unwrap_or_default().display().to_string());
            let spec = Spec {
                id: id.into(),
                backend: backend.into(),
                mode: flag(args, "--mode").unwrap_or("pipe").into(),
                cwd,
                model: flag(args, "--model").map(String::from),
                opts,
                created: log::now_ms(),
                dir: Default::default(),
            };
            let spec = if core::session_dir(data, id).join("session.json").exists() {
                core::load(data, id)?
            } else {
                core::create(data, &spec)?
            };
            owner::ensure(data, &spec)?;
            match flag(args, "--text") {
                Some(text) => send(data, &spec, text, flag(args, "--cid"), None),
                None => Ok(json!({"ok": true, "id": id})),
            }
        }
        "send" => {
            let (id, text) = (arg(args, 1)?, arg(args, 2)?);
            let spec = core::load(data, id)?;
            owner::ensure(data, &spec)?;
            send(
                data,
                &spec,
                text,
                flag(args, "--cid"),
                flag(args, "--backend"),
            )
        }
        "status" => {
            let all = procs::all();
            let ids: Vec<String> = if has(args, "--all") {
                core::ids(data)
            } else {
                args[1..].to_vec()
            };
            let mut stdout = io::stdout().lock();
            for id in &ids {
                let s = status_of(data, id, &all)
                    .unwrap_or_else(|e| json!({"id": id, "ok": false, "error": e.to_string()}));
                writeln!(stdout, "{s}")?;
            }
            Ok(Value::Null)
        }
        "stop" => {
            let id = arg(args, 1)?;
            match owner::call(data, id, json!({"op": "stop", "by": "user"})) {
                Ok(v) => Ok(v),
                // No owner: nothing can be running under us, but leftovers recorded in the log still go.
                Err(e) => {
                    let f = core::fold(&core::session_dir(data, id), true)?;
                    Ok(json!({"ok": true, "owner": e.to_string(), "swept": core::sweep(&f.fold)}))
                }
            }
        }
        "recover" => {
            let id = arg(args, 1)?;
            let spec = core::load(data, id)?;
            owner::ensure(data, &spec)?;
            let f = core::fold(&spec.dir, true)?;
            let live = fold::live(&f.fold, Owner::Alive, data, &procs::all());
            let call = call_fn(data, id);
            Ok(core::recover(&spec, &f.fold, &live, child(data, id), &call))
        }
        "delete" => {
            let id = arg(args, 1)?;
            let spec = core::load(data, id)?;
            let _ = owner::call(data, id, json!({"op": "stop", "by": "delete"}));
            owner::release(data, id)?;
            let f = core::fold(&spec.dir, false)?;
            Ok(core::delete(&spec, &f.fold))
        }
        "up" => {
            for id in &args[1..] {
                owner::ensure(data, &core::load(data, id)?)?;
            }
            Ok(json!({"ok": true}))
        }
        "owner" => Ok(
            json!({"pid": owner::pid(data, arg(args, 1)?), "state": format!("{:?}", owner::state(data, arg(args, 1)?))}),
        ),
        "read" => read(data, arg(args, 1)?, args),
        "index" => index(data, has(args, "--cold")),
        "transcript" => {
            let id = arg(args, 1)?;
            let spec = core::load(data, id)?;
            // A tool may be announced at start and again at its end: count it once, by id. Ids are
            // only unique within a turn (a backend may number them afresh per process).
            let (mut texts, mut turn, mut tools) = (0u64, 0u64, std::collections::BTreeSet::new());
            core::read(&spec.dir, |i| match i["kind"].as_str() {
                Some("text") => texts += 1,
                Some("turn_start") => turn += 1,
                Some("tool") => {
                    tools.insert((turn, i["id"].as_str().unwrap_or("").to_string()));
                }
                _ => {}
            })?;
            let tools = tools.len();
            let f = core::fold(&spec.dir, true)?;
            let theirs: Vec<Value> = f
                .fold
                .resume
                .iter()
                .filter_map(|(b, r)| {
                    adapters::get(b)?
                        .transcript(&spec, r)
                        .map(|(x, t)| json!({"backend": b, "texts": x, "tools": t}))
                })
                .collect();
            Ok(json!({"ok": true, "ours": {"texts": texts, "tools": tools}, "theirs": theirs}))
        }
        _ => Err(io::Error::other(USAGE)),
    }
}

fn send(
    data: &Path,
    spec: &Spec,
    text: &str,
    cid: Option<&str>,
    backend: Option<&str>,
) -> io::Result<Value> {
    let cid = cid
        .map(String::from)
        .unwrap_or_else(|| format!("c{}-{}", log::now_ms(), process::id()));
    let f = core::fold(&spec.dir, true)?;
    let call = call_fn(data, &spec.id);
    let mut reply = core::send(
        spec,
        &f.fold,
        child(data, &spec.id),
        &call,
        &cid,
        "user",
        text,
        backend,
        None,
    );
    // A busy refusal can race a turn that just ended; one retry settles it.
    if reply["error"] == "busy" {
        thread::sleep(Duration::from_millis(200));
        let f = core::fold(&spec.dir, true)?;
        reply = core::send(
            spec,
            &f.fold,
            child(data, &spec.id),
            &call,
            &cid,
            "user",
            text,
            backend,
            None,
        );
    }
    // A dropped connection says nothing about the log: the log itself does.
    if reply["result"].is_null() {
        let logged = core::fold(&spec.dir, true).is_ok_and(|f| f.fold.cids.contains_key(&cid));
        reply["result"] = match (reply["ok"] == true, logged) {
            (true, _) => "delivered",
            (false, true) => "logged",
            (false, false) => "not_logged",
        }
        .into();
    }
    Ok(reply)
}

fn read(data: &Path, id: &str, args: &[String]) -> io::Result<Value> {
    let spec = core::load(data, id)?;
    let started = Instant::now();
    if let Some(n) = flag(args, "--tail") {
        let items = core::tail(&spec.dir, &spec, n.parse().unwrap_or(50))?;
        return Ok(
            json!({"ok": true, "items": items.len(), "ms": started.elapsed().as_secs_f64() * 1000.0}),
        );
    }
    let quiet = has(args, "--hash");
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut count = 0u64;
    if !has(args, "--follow") {
        let hash = core::read(&spec.dir, |item| {
            count += 1;
            if !quiet {
                let _ = writeln!(stdout, "{item}");
            }
        })?;
        stdout.flush()?;
        return Ok(
            json!({"ok": true, "items": count, "hash": format!("{hash:016x}"), "ms": started.elapsed().as_millis() as u64}),
        );
    }
    // Follow: the same normaliser over the same frames, as they arrive.
    let mut reader = log::Reader::open(&spec.dir.join("log"), 0, 0)?;
    let mut norm = brigadier_core::norm::Norm::default();
    let mut items = vec![];
    loop {
        while let Some(frame) = reader.frame()? {
            norm.push(&frame, &mut items);
            for item in items.drain(..) {
                writeln!(stdout, "{item}")?;
            }
        }
        stdout.flush()?;
        thread::sleep(Duration::from_millis(100));
    }
}

fn index(data: &Path, cold: bool) -> io::Result<Value> {
    let started = Instant::now();
    let all = procs::all();
    let mut rows = vec![];
    for id in core::ids(data) {
        let dir = core::session_dir(data, &id);
        let Ok(f) = core::fold(&dir, !cold) else {
            continue;
        };
        let live = fold::live(&f.fold, owner::state(data, &id), data, &all);
        let s = fold::status(&f.fold, &live);
        rows.push(json!({"id": id, "state": s["state"], "items": f.fold.items, "backend": f.fold.backend, "bytes": f.pos}));
    }
    core::write_atomic(
        &data.join("index.json"),
        serde_json::to_string(&rows)?.as_bytes(),
    )?;
    Ok(json!({"ok": true, "sessions": rows.len(), "ms": started.elapsed().as_millis() as u64}))
}
