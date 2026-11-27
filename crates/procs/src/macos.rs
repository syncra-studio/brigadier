//! The kernel facts the hosts use, so start times match the fake agent's ledger.

use brigadier_frames::procs;

pub fn starts() -> Vec<(u32, u64)> {
    procs::all()
        .into_iter()
        .map(|p| (p.pid as u32, p.start_us))
        .collect()
}

pub fn signal(pid: u32, start: u64, sig: &str) -> bool {
    let sig = match sig {
        "SIGKILL" => libc::SIGKILL,
        "SIGTERM" => libc::SIGTERM,
        "SIGSTOP" => libc::SIGSTOP,
        "SIGCONT" => libc::SIGCONT,
        _ => return false,
    };
    let pid = pid as i32;
    procs::same(pid, start).is_some() && unsafe { libc::kill(pid, sig) == 0 }
}
