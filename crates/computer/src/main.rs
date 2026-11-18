//! Brigadier Computer Use, the helper app that holds macOS's Accessibility and Screen Recording
//! grants [D2032, D908, D913]. It runs the pinned Cua Driver as its own child over the child's
//! stdio, so no socket an agent could reach, and pipes it to the daemon: driver calls come in as
//! frames with an `rpc`, and each line the driver writes goes back as a `computer_reply`. All logic
//! is in the daemon.

use brigadier_frames::wire::{self, read_frame, write_frame};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{self, Command, Stdio};
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
    let mut back = daemon.try_clone().unwrap_or_else(|e| fail(&e));
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(reply) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let frame = json!({"op": "computer_reply", "reply": reply}).to_string();
            if write_frame(&mut back, &frame).is_err() {
                break;
            }
        }
        end()
    });

    // Only frames with an `rpc` go to the driver: the hello and the daemon's replies don't.
    while let Ok(text) = read_frame(&mut daemon) {
        let Ok(frame) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(rpc) = frame.get("rpc")
            && writeln!(stdin, "{rpc}").is_err()
        {
            break;
        }
    }
    end()
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
mod mac {
    pub fn ask(_: &str) {}
}
