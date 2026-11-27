//! /proc's start time, as microseconds since 1970: boot time plus the start in clock ticks.

use std::fs;

fn start_us(pid: u32, boot_us: u64, tick: u64) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // Fields after the name, which may hold spaces and parentheses: state is the first, start the 20th.
    let fields: Vec<&str> = stat
        .get(stat.rfind(')')? + 1..)?
        .split_whitespace()
        .collect();
    let ticks: u64 = fields.get(19)?.parse().ok()?;
    (fields.first() != Some(&"Z")).then(|| boot_us + ticks * 1_000_000 / tick)
}

fn clock() -> Option<(u64, u64)> {
    let stat = fs::read_to_string("/proc/stat").ok()?;
    let boot: u64 = stat
        .lines()
        .find_map(|l| l.strip_prefix("btime "))?
        .trim()
        .parse()
        .ok()?;
    let tick = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    (tick > 0).then(|| (boot * 1_000_000, tick as u64))
}

pub fn starts() -> Vec<(u32, u64)> {
    let (Some((boot, tick)), Ok(dir)) = (clock(), fs::read_dir("/proc")) else {
        return Vec::new();
    };
    dir.filter_map(|e| e.ok()?.file_name().to_str()?.parse::<u32>().ok())
        .filter_map(|pid| Some((pid, start_us(pid, boot, tick)?)))
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
    clock().and_then(|(boot, tick)| start_us(pid, boot, tick)) == Some(start)
        && unsafe { libc::kill(pid as i32, sig) == 0 }
}
