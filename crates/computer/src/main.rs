//! Brigadier Computer Use, the helper app that holds macOS's Accessibility and Screen Recording
//! grants [D2032, D908, D913]. It runs the pinned Cua Driver as its own child over the child's
//! stdio, so no socket an agent could reach, and pipes it to the daemon: driver calls come in as
//! frames with an `rpc`, and each line the driver writes goes back as a `computer_reply`. All logic
//! is in the daemon. A call named `brigadier/…` is the helper's own (ax.rs), answered the same way.

#[cfg(target_os = "macos")]
mod ax;

use brigadier_frames::wire::{self, read_frame, write_frame};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{self, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::{env, thread};

const USAGE: &str =
    "usage: brigadier-computer --data <dir> [--ask accessibility|screenRecording|all]";

fn main() {
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
    // Never waited on: this process exits right after the driver does, so no zombie outlives it.
    #[expect(clippy::zombie_processes)]
    let mut child = Command::new(driver)
        .args(["mcp", "--direct", "--embedded"])
        .env("CUA_DRIVER_EMBEDDED", "1")
        .env("CUA_DRIVER_HOST_BUNDLE_ID", "sh.brigadier.computer-use")
        .env("CUA_DRIVER_RS_TELEMETRY_ENABLED", "0")
        .env("DO_NOT_TRACK", "1")
        .env("CUA_DRIVER_RS_UPDATE_CHECK", "false")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap_or_else(|e| fail(&e));
    // Unreaped, the pid stays the driver's until this process exits.
    let pid = child.id() as libc::pid_t;
    let end = move || -> ! {
        unsafe { libc::kill(pid, libc::SIGKILL) };
        process::exit(0)
    };

    let (stdout, mut stdin) = (child.stdout.take().unwrap(), child.stdin.take().unwrap());
    let back = Arc::new(Mutex::new(daemon.try_clone().unwrap_or_else(|e| fail(&e))));
    let send = move |reply: Value| {
        let frame = json!({"op": "computer_reply", "reply": reply}).to_string();
        let mut out = back
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        write_frame(&mut out, &frame).is_ok()
    };
    let to_daemon = send.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(reply) = serde_json::from_str::<Value>(&line) else {
                continue;
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
            } else if writeln!(stdin, "{rpc}").is_err() {
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
