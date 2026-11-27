//! Toolhelp snapshots for the list, and the creation time as microseconds since 1970. Each act
//! holds the process's handle from the start-time check on, so its pid can't be reused meanwhile.

use std::collections::HashSet;
use std::mem::size_of;
use windows_sys::Wdk::System::Threading::{
    NtQueryInformationProcess, ProcessCommandLineInformation,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE, STILL_ACTIVE, UNICODE_STRING,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessIdOfThread, GetProcessTimes, OpenProcess, OpenThread,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, ResumeThread, SuspendThread,
    THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME, TerminateProcess,
};

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}
fn handle(h: HANDLE) -> Option<Handle> {
    (!h.is_null() && h != INVALID_HANDLE_VALUE).then_some(Handle(h))
}

fn start_us(p: &Handle) -> Option<u64> {
    let mut t = [FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    }; 4];
    let [c, e, k, u] = &mut t;
    if unsafe { GetProcessTimes(p.0, c, e, k, u) } == 0 {
        return None;
    }
    let ticks = (u64::from(t[0].dwHighDateTime) << 32) | u64::from(t[0].dwLowDateTime);
    // 100 ns ticks since 1601.
    ticks.checked_sub(116_444_736_000_000_000).map(|t| t / 10)
}

fn processes() -> Vec<PROCESSENTRY32W> {
    let mut out = Vec::new();
    let Some(snap) = handle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return out;
    };
    let mut e = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut more = unsafe { Process32FirstW(snap.0, &mut e) } != 0;
    while more {
        out.push(e);
        more = unsafe { Process32NextW(snap.0, &mut e) } != 0;
    }
    out
}

fn threads(pid: u32) -> Vec<u32> {
    let mut out = Vec::new();
    let Some(snap) = handle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }) else {
        return out;
    };
    let mut e = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut more = unsafe { Thread32First(snap.0, &mut e) } != 0;
    while more {
        if e.th32OwnerProcessID == pid {
            out.push(e.th32ThreadID);
        }
        more = unsafe { Thread32Next(snap.0, &mut e) } != 0;
    }
    out
}

fn open(pid: u32, access: u32) -> Option<Handle> {
    handle(unsafe { OpenProcess(access, 0, pid) })
}

fn cmdline(p: &Handle) -> Option<String> {
    // A command line is at most 32767 UTF-16 units, after the UNICODE_STRING that points at it.
    let mut buf = vec![0u64; 8200];
    let mut len = 0;
    let bytes = (buf.len() * 8) as u32;
    let at = buf.as_mut_ptr().cast();
    if unsafe { NtQueryInformationProcess(p.0, ProcessCommandLineInformation, at, bytes, &mut len) }
        < 0
    {
        return None;
    }
    let s = unsafe { &*buf.as_ptr().cast::<UNICODE_STRING>() };
    if s.Buffer.is_null() {
        return None;
    }
    let units = unsafe { std::slice::from_raw_parts(s.Buffer, usize::from(s.Length) / 2) };
    Some(String::from_utf16_lossy(units))
}

pub fn starts() -> Vec<(u32, u64)> {
    processes()
        .iter()
        .filter_map(|e| {
            let p = open(e.th32ProcessID, PROCESS_QUERY_LIMITED_INFORMATION)?;
            Some((e.th32ProcessID, start_us(&p)?))
        })
        .collect()
}

/// shortcut: no process groups on Windows, so pgid is 0 and the drill's group checks stay red;
/// phase 2's named job per child gives the group.
pub fn ps() {
    for e in processes().iter().filter(|e| e.th32ProcessID != 0) {
        let name = String::from_utf16_lossy(
            &e.szExeFile[..e.szExeFile.iter().position(|&c| c == 0).unwrap_or(260)],
        );
        let line =
            open(e.th32ProcessID, PROCESS_QUERY_LIMITED_INFORMATION).and_then(|p| cmdline(&p));
        let cmd = line
            .filter(|l| !l.is_empty())
            .unwrap_or(name)
            .replace(['\r', '\n'], " ");
        println!("{} 0 {} R {cmd}", e.th32ProcessID, e.th32ParentProcessID);
    }
}

/// Every thread of the process, each opened and proven still its own before it's touched.
fn each_thread(pid: u32, mut act: impl FnMut(u32, HANDLE)) {
    for tid in threads(pid) {
        let access = THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION;
        let Some(t) = handle(unsafe { OpenThread(access, 0, tid) }) else {
            continue;
        };
        if unsafe { GetProcessIdOfThread(t.0) } == pid {
            act(tid, t.0);
        }
    }
}

pub fn signal(pid: u32, start: u64, sig: &str) -> bool {
    let Some(p) = open(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE) else {
        return false;
    };
    let mut code = 0;
    let live = unsafe { GetExitCodeProcess(p.0, &mut code) } != 0 && code == STILL_ACTIVE as u32;
    if !live || start_us(&p) != Some(start) {
        return false;
    }
    match sig {
        "SIGKILL" | "SIGTERM" => unsafe { TerminateProcess(p.0, 1) != 0 },
        // Again until a pass finds no thread it hasn't frozen: threads started meanwhile.
        "SIGSTOP" => {
            let mut frozen = HashSet::new();
            loop {
                let before = frozen.len();
                each_thread(pid, |tid, t| {
                    if !frozen.contains(&tid) && unsafe { SuspendThread(t) } != u32::MAX {
                        frozen.insert(tid);
                    }
                });
                if frozen.len() == before {
                    return before > 0;
                }
            }
        }
        "SIGCONT" => {
            let mut any = false;
            each_thread(pid, |_, t| any |= unsafe { ResumeThread(t) } != u32::MAX);
            any
        }
        _ => false,
    }
}
