//! Brigadier Computer Use, the helper app that holds macOS's Accessibility and Screen Recording
//! grants [D2032, D908, D913]. It runs the pinned Cua Driver as its own child over the child's
//! stdio, so no socket an agent could reach, and pipes it to the daemon: driver calls come in as
//! frames with an `rpc`, and each driver answer goes back as a `computer_reply`. The driver runs as
//! Cua's private worker, which draws the agent cursor [D956]; its channel is translated to and from
//! the JSON-RPC the daemon speaks. All logic is in the daemon. A call named `brigadier/…` is the
//! helper's own (ax.rs, D928), answered the same way.

#[cfg(target_os = "macos")]
mod ax;

use brigadier_frames::wire::{self, read_frame, write_frame};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{self, Child, Command, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;
use std::{env, thread};

const USAGE: &str =
    "usage: brigadier-computer --data <dir> [--ask accessibility|screenRecording|all]";

fn main() {
    // Computer use is macOS's alone [D158].
    if cfg!(not(target_os = "macos")) {
        fail(&"Computer use works only on macOS.")
    }
    let args: Vec<String> = env::args().collect();
    let flag = |name: &str| {
        let at = args.iter().position(|a| a == name)?;
        Some(args.get(at + 1).map(String::as_str).unwrap_or(""))
    };
    let Some(data) = flag("--data").filter(|d| !d.is_empty()) else {
        fail(&USAGE)
    };
    match flag("--ask") {
        None => {}
        Some(what @ ("accessibility" | "screenRecording" | "all")) => mac::ask(what),
        Some(_) => fail(&USAGE),
    }

    let sock = Path::new(data).join("daemon.sock");
    let mut conn = wire::connect_daemon(&sock, Duration::from_secs(5)).unwrap_or_else(|e| fail(&e));
    // Anyone can launch this app on a socket of their own: only Brigadier's daemon may drive it.
    let peer = wire::peer_pid(&conn.stream).unwrap_or_else(|e| fail(&e));
    if !mac::ours(peer) {
        fail(&"the daemon isn't signed as this app is")
    }
    conn.set_timeout(None).unwrap_or_else(|e| fail(&e));
    let mut daemon = conn.stream;
    write_frame(
        &mut daemon,
        &json!({"id": 1, "op": "computer_helper"}).to_string(),
    )
    .unwrap_or_else(|e| fail(&e));

    // Contents/MacOS/brigadier-computer → Contents/Resources/cua-driver.
    let exe = env::current_exe().unwrap_or_else(|e| fail(&e));
    let driver = exe
        .parent()
        .and_then(Path::parent)
        .unwrap_or(&exe)
        .join("Resources/cua-driver");
    // Cua's private worker draws its agent cursor [D956]; if it won't start, today's direct MCP
    // runs without one, so computer use never breaks for the cursor.
    let generation = format!("brigadier-{}", process::id());
    let (mut child, lines, cursor_off) = match worker(&driver, &generation) {
        Ok((child, lines)) => (child, lines, None),
        Err(why) => {
            let (child, lines) =
                start(&driver, &["mcp", "--direct", "--embedded"]).unwrap_or_else(|e| fail(&e));
            (child, lines, Some(why))
        }
    };
    let private = cursor_off.is_none();
    // Unreaped, the pid stays the driver's until this process exits.
    let pid = child.id() as i32;
    let start = brigadier_frames::procs::info(pid).map_or(0, |p| p.start_us);
    let end = move || -> ! {
        brigadier_frames::procs::kill_checked(pid, start);
        process::exit(0)
    };

    let mut stdin = child.stdin.take().unwrap();
    let back = Arc::new(Mutex::new(daemon.try_clone().unwrap_or_else(|e| fail(&e))));
    let send = move |reply: Value| {
        let frame = json!({"op": "computer_reply", "reply": reply}).to_string();
        let mut out = back
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        write_frame(&mut out, &frame).is_ok()
    };
    if let Some(why) = cursor_off {
        eprintln!("brigadier-computer: no agent cursor: {why}");
        send(json!({"jsonrpc": "2.0", "method": "brigadier/cursor", "params": {"error": why}}));
    }
    let to_daemon = send.clone();
    let gen_back = generation.clone();
    thread::spawn(move || {
        for line in lines {
            let Ok(reply) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let reply = match private {
                true => match answer(&reply, &gen_back) {
                    Some(r) => r,
                    None => continue,
                },
                false => reply,
            };
            if !to_daemon(reply) {
                break;
            }
        }
        end()
    });

    // Only frames with an `rpc` go to the driver: the hello and the daemon's replies don't.
    let calls = thread::spawn(move || {
        while let Ok(text) = read_frame(&mut daemon) {
            let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let Some(rpc) = frame.get("rpc") else {
                continue;
            };
            let id = &rpc["id"];
            if let Some(method) = rpc["method"]
                .as_str()
                .filter(|m| m.starts_with("brigadier/"))
            {
                let (method, rpc, send) = (method.to_string(), rpc.clone(), send.clone());
                thread::spawn(move || {
                    let id = &rpc["id"];
                    send(match ax::handle(&method, &rpc["params"]) {
                        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                        Err(e) => json!({"jsonrpc": "2.0", "id": id, "error": {"message": e}}),
                    });
                });
                continue;
            }
            let line = match (private, rpc["method"].as_str(), id.as_u64()) {
                (false, ..) => rpc.to_string(),
                // A notification (`notifications/initialized`) needs nothing from the worker.
                (true, _, None) => continue,
                // The worker was initialized before this; the daemon's handshake is answered here.
                (true, Some("initialize"), Some(_)) => {
                    send(json!({"jsonrpc": "2.0", "id": id, "result": {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "cua-driver", "version": "private worker"}}}));
                    continue;
                }
                (true, Some("tools/call"), Some(n)) => json!({"protocol_version": WORKER_PROTOCOL, "request_id": n, "generation": generation, "operation": "call", "name": rpc["params"]["name"], "arguments": rpc["params"]["arguments"]}).to_string(),
                (true, ..) => {
                    send(json!({"jsonrpc": "2.0", "id": id, "error": {"message": "Not a call Brigadier Computer Use passes on."}}));
                    continue;
                }
            };
            if writeln!(stdin, "{line}").is_err() {
                break;
            }
        }
        end()
    });
    // macOS's "Quit & Reopen" after a grant quits this app by Apple Event, which only AppKit's
    // loop answers; the daemon starts it again with its arguments [D935].
    mac::serve();
    let _ = calls.join();
}

/// Cua's private-worker channel version, as in its SDK (worker.rs) at the pinned 0.54.0.
const WORKER_PROTOCOL: u64 = 1;
/// The longest Cua's private worker may take to answer its `initialize`.
const WORKER_WAIT: Duration = Duration::from_secs(5);

/// Starts the driver with `args`: the child, and each line it writes, until it closes.
fn start(driver: &Path, args: &[&str]) -> std::io::Result<(Child, mpsc::Receiver<String>)> {
    // Never waited on: this process exits right after the driver does, so no zombie outlives it.
    let mut child = Command::new(driver)
        .args(args)
        .env("CUA_DRIVER_EMBEDDED", "1")
        .env("CUA_DRIVER_HOST_BUNDLE_ID", "sh.brigadier.computer-use")
        .env("CUA_DRIVER_RS_TELEMETRY_ENABLED", "0")
        .env("DO_NOT_TRACK", "1")
        .env("CUA_DRIVER_RS_UPDATE_CHECK", "false")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let (to, lines) = mpsc::channel();
    let stdout = child.stdout.take().unwrap();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if to.send(line).is_err() {
                break;
            }
        }
    });
    Ok((child, lines))
}

/// Cua's private worker [D956]: the driver with its agent cursor, still over stdio only [D913].
/// Set up as `mcp --direct` runs today: Cua's standard mode, no authorization host, so nothing of
/// Cua's ever asks the user [D903]; Brigadier's block list and pause stay in the daemon [D909, D910].
fn worker(driver: &Path, generation: &str) -> Result<(Child, mpsc::Receiver<String>), String> {
    let (mut child, lines) = start(driver, &["__private-worker", "--generation", generation])
        .map_err(|e| e.to_string())?;
    let init = json!({"protocol_version": WORKER_PROTOCOL, "request_id": 0, "generation": generation, "operation": "initialize", "arguments": {
        "host_bundle_id": "sh.brigadier.computer-use",
        "configured_driver": {"claude_code_compatibility": false, "authorization": {
            "allowed_modes": ["standard"], "compatibility_mode": "standard",
            "compatibility_capability_manifest_path": null, "compatibility_bounded_manifest_path": null,
            "unrestricted_acknowledged": false, "max_session_ttl_seconds": 86_400, "max_idle_ttl_seconds": 3_600}}}});
    let mut stdin = child.stdin.take().unwrap();
    let ready = writeln!(stdin, "{init}")
        .map_err(|e| e.to_string())
        .and_then(|()| {
            let line = lines
                .recv_timeout(WORKER_WAIT)
                .map_err(|_| "Cua's private worker didn't start.".to_string())?;
            let r: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            match r["ok"] == true && r["request_id"] == 0 && r["generation"] == generation {
                true => Ok(()),
                false => Err(r["error"]
                    .as_str()
                    .unwrap_or("Cua's private worker refused.")
                    .to_string()),
            }
        });
    match ready {
        Ok(()) => {
            child.stdin = Some(stdin);
            Ok((child, lines))
        }
        Err(why) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(why)
        }
    }
}

/// A private-worker answer as the JSON-RPC reply the daemon reads today, or none when it isn't
/// this generation's. A refusal or partial result is in the tool's own result (`isError`), as with
/// MCP; a failed call is an error, and one that may have run says so.
fn answer(r: &Value, generation: &str) -> Option<Value> {
    if r["protocol_version"] != WORKER_PROTOCOL || r["generation"] != generation {
        return None;
    }
    let id = r["request_id"].as_u64()?;
    if r["ok"] == true {
        return Some(json!({"jsonrpc": "2.0", "id": id, "result": r["result"]}));
    }
    let mut message = r["error"]
        .as_str()
        .unwrap_or("The driver refused.")
        .to_string();
    if r["completion"] != "not_started" {
        message.push_str(" It may have happened: read again.");
    }
    Some(
        json!({"jsonrpc": "2.0", "id": id, "error": {"message": message, "data": {"code": r["error_code"], "completion": r["completion"]}}}),
    )
}

fn fail(error: &dyn std::fmt::Display) -> ! {
    eprintln!("brigadier-computer: {error}");
    process::exit(1)
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    use std::ptr;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        static kAXTrustedCheckOptionPrompt: *const c_void;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFBooleanTrue: *const c_void;
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            count: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *const c_void;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    /// Process `pid` is signed by this app's team. An app without a team (a dev build, ad hoc)
    /// holds no lasting grant, so it takes any daemon.
    // shortcut: the owner's Developer ID team [D493] is written here; read it from this app's
    // own signature if another team ever signs Brigadier.
    pub fn ours(pid: i32) -> bool {
        use security_framework::os::macos::code_signing::{
            Flags, GuestAttributes, SecCode, SecRequirement,
        };
        let Ok(team) = "anchor apple generic and certificate leaf[subject.OU] = \"7JQSPMWT79\""
            .parse::<SecRequirement>()
        else {
            return false;
        };
        let signed = |code: SecCode| code.check_validity(Flags::NONE, &team).is_ok();
        if !SecCode::for_self(Flags::NONE).is_ok_and(signed) {
            return true;
        }
        let mut guest = GuestAttributes::new();
        guest.set_pid(pid);
        SecCode::copy_guest_with_attribues(None, &guest, Flags::NONE).is_ok_and(signed)
    }

    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {}

    unsafe extern "C" {
        fn objc_getClass(name: *const std::ffi::c_char) -> *mut c_void;
        fn sel_registerName(name: *const std::ffi::c_char) -> *mut c_void;
        fn objc_msgSend();
    }

    /// Runs NSApplication on this, the main, thread: a Quit from macOS ends the process.
    pub fn serve() {
        unsafe {
            let send: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let app = send(
                objc_getClass(c"NSApplication".as_ptr()),
                sel_registerName(c"sharedApplication".as_ptr()),
            );
            send(app, sel_registerName(c"run".as_ptr()));
        }
    }

    /// Asks macOS for the grants `what` names, charged to this app: its own prompt or Settings.
    pub fn ask(what: &str) {
        unsafe {
            if what != "screenRecording" {
                let options = CFDictionaryCreate(
                    ptr::null(),
                    &kAXTrustedCheckOptionPrompt,
                    &kCFBooleanTrue,
                    1,
                    &kCFTypeDictionaryKeyCallBacks,
                    &kCFTypeDictionaryValueCallBacks,
                );
                AXIsProcessTrustedWithOptions(options);
            }
            if what != "accessibility" {
                CGRequestScreenCaptureAccess();
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod ax {
    pub fn handle(_: &str, _: &serde_json::Value) -> Result<serde_json::Value, String> {
        Err("Only on macOS.".into())
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    pub fn ask(_: &str) {}
    pub fn serve() {}
    pub fn ours(_: i32) -> bool {
        true
    }
}
