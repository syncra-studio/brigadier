//! The drill's process identities and checked signals, using the same kernel facts as the hosts.

use brigadier_frames::procs;
use serde_json::{Map, Value, json};

pub fn run(args: &[String]) {
    if args.is_empty() {
        let starts: Map<String, Value> = procs::all()
            .into_iter()
            .map(|p| (p.pid.to_string(), json!(p.start_us)))
            .collect();
        println!("{}", Value::Object(starts));
        return;
    }
    let pid = args.first().and_then(|s| s.parse::<i32>().ok());
    let start = args.get(1).and_then(|s| s.parse::<u64>().ok());
    let signal = match args.get(2).map(String::as_str) {
        Some("SIGKILL") => Some(libc::SIGKILL),
        Some("SIGTERM") => Some(libc::SIGTERM),
        Some("SIGSTOP") => Some(libc::SIGSTOP),
        Some("SIGCONT") => Some(libc::SIGCONT),
        _ => None,
    };
    let killed = match (pid, start, signal) {
        (Some(pid), Some(start), Some(sig)) if pid > 1 && start > 0 => {
            procs::same(pid, start).is_some() && unsafe { libc::kill(pid, sig) == 0 }
        }
        _ => false,
    };
    println!("{killed}");
}
