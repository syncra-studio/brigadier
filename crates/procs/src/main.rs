//! The drill's process identities and checked signals, per system. A pid is acted on only while it
//! is still the process that started at the recorded time, so a reused pid is never hit [D97 D100].
//! It needs nothing of the product's, so the drill runs where the product isn't ported yet.
//!
//!   brigadier-procs                       {pid: start_us} of every process
//!   brigadier-procs PID START_US SIGNAL   true when signalled: SIGKILL, SIGTERM, SIGSTOP, SIGCONT
//!   brigadier-procs ps                    Windows only: `ps -axo pid=,pgid=,ppid=,stat=,command=`'s lines

#[cfg_attr(target_os = "linux", path = "linux.rs")]
#[cfg_attr(target_os = "macos", path = "macos.rs")]
#[cfg_attr(windows, path = "windows.rs")]
mod sys;

use serde_json::{Map, Value, json};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(windows)]
    if args.first().map(String::as_str) == Some("ps") {
        sys::ps();
        return;
    }
    if args.is_empty() {
        let starts: Map<String, Value> = sys::starts()
            .into_iter()
            .map(|(pid, start)| (pid.to_string(), json!(start)))
            .collect();
        println!("{}", Value::Object(starts));
        return;
    }
    let pid = args.first().and_then(|s| s.parse::<u32>().ok());
    let start = args.get(1).and_then(|s| s.parse::<u64>().ok());
    let signalled = match (pid, start, args.get(2)) {
        (Some(pid), Some(start), Some(sig)) if pid > 1 && start > 0 => sys::signal(pid, start, sig),
        _ => false,
    };
    println!("{signalled}");
}
