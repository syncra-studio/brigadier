//! Windows' own pieces under the ports: handles, wide strings, start times, and the named jobs
//! that stand in for process groups and the watchdog (PLAN.md step 10).
//!
//! A job is named `brigadier-<kind>-<pid>-<start_us>` after the process it was made for, so the
//! name can't be confused with a reused pid's: `g` for each child Brigadier starts (its group),
//! `h` for a session host. Any process lists the live ones by name, as `ps` lists groups.

use std::ffi::OsStr;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{NtOpenDirectoryObject, NtQueryDirectoryObject};
use windows_sys::Wdk::System::Threading::{
    NtQueryInformationProcess, ProcessBasicInformation, ProcessCommandLineInformation,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, FILETIME, GetLastError, HANDLE, INVALID_HANDLE_VALUE,
    STILL_ACTIVE, UNICODE_STRING,
};
use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation, OpenJobObjectW,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, GetProcessIdOfThread, GetProcessTimes, OpenProcess,
    OpenThread, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ, ResumeThread,
    THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};

pub struct Handle(pub HANDLE);
// A kernel handle is usable from any thread.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

pub fn handle(h: HANDLE) -> Option<Handle> {
    (!h.is_null() && h != INVALID_HANDLE_VALUE).then_some(Handle(h))
}

/// NUL-ended UTF-16, for every W call.
pub fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain([0]).collect()
}

pub fn open(pid: u32, access: u32) -> Option<Handle> {
    handle(unsafe { OpenProcess(access, 0, pid) })
}

/// The creation time, in microseconds since 1970 as on every system.
pub fn start_us(p: &Handle) -> Option<u64> {
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

pub fn live(p: &Handle) -> bool {
    let mut code = 0;
    unsafe { GetExitCodeProcess(p.0, &mut code) != 0 && code == STILL_ACTIVE as u32 }
}

pub fn processes() -> Vec<PROCESSENTRY32W> {
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

/// Lets a child started suspended run: its threads, each proven its own before it's resumed
/// [D97 D100]. The caller holds the process's handle, so the pid can't be reused meanwhile.
pub fn resume(pid: u32) -> io::Result<()> {
    let mut any = false;
    for tid in threads(pid) {
        let access = THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION;
        let Some(t) = handle(unsafe { OpenThread(access, 0, tid) }) else {
            continue;
        };
        if unsafe { GetProcessIdOfThread(t.0) } == pid {
            any |= unsafe { ResumeThread(t.0) } != u32::MAX;
        }
    }
    any.then_some(())
        .ok_or_else(|| io::Error::other("The new process couldn't be started."))
}

/// `PROCESS_BASIC_INFORMATION`, without the features its PEB pointer type needs.
#[repr(C)]
#[derive(Default)]
struct Basic {
    exit: i32,
    peb: usize,
    affinity: usize,
    priority: i32,
    pid: usize,
    parent: usize,
}

fn basic(p: &Handle) -> Option<Basic> {
    let mut b = Basic::default();
    let size = size_of::<Basic>() as u32;
    let at = (&mut b as *mut Basic).cast();
    let mut len = 0;
    (unsafe { NtQueryInformationProcess(p.0, ProcessBasicInformation, at, size, &mut len) } >= 0)
        .then_some(b)
}

/// The parent's pid as the child was given it. Windows never reparents, so the caller checks the
/// parent started first before trusting it.
pub fn parent(p: &Handle) -> Option<u32> {
    basic(p).map(|b| b.parent as u32)
}

pub fn cmdline(p: &Handle) -> Option<String> {
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

/// A command line split as the C runtime splits it for `main`.
pub fn split(line: &str) -> Vec<String> {
    let (mut out, mut word, mut quoted, mut any) = (vec![], String::new(), false, false);
    let mut chars = line.chars().peekable();
    // The program's name ends at a space or its closing quote; backslashes are plain in it.
    for c in chars.by_ref() {
        match c {
            '"' => quoted = !quoted,
            ' ' | '\t' if !quoted => break,
            c => word.push(c),
        }
    }
    out.push(std::mem::take(&mut word));
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let mut n = 1;
                while chars.peek() == Some(&'\\') {
                    chars.next();
                    n += 1;
                }
                if chars.peek() == Some(&'"') {
                    word.extend(std::iter::repeat_n('\\', n / 2));
                    if n % 2 == 1 {
                        chars.next();
                        word.push('"');
                    }
                } else {
                    word.extend(std::iter::repeat_n('\\', n));
                }
                any = true;
            }
            '"' if quoted && chars.peek() == Some(&'"') => {
                chars.next();
                word.push('"');
            }
            '"' => {
                quoted = !quoted;
                any = true;
            }
            ' ' | '\t' if !quoted => {
                if any || !word.is_empty() {
                    out.push(std::mem::take(&mut word));
                }
                any = false;
            }
            c => {
                word.push(c);
                any = true;
            }
        }
    }
    if any || !word.is_empty() {
        out.push(word);
    }
    out
}

/// The environment a process runs with, from its own memory: the same user's processes only.
/// x64 offsets: PEB.ProcessParameters at 0x20; its Environment at 0x80 and EnvironmentSize at
/// 0x3F0, as they have been since Vista.
pub fn environ(pid: u32) -> Option<Vec<String>> {
    let p = open(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ)?;
    let peb = basic(&p)?.peb;
    let read = |at: usize, buf: &mut [u8]| unsafe {
        let mut n = 0;
        let ok = ReadProcessMemory(p.0, at as _, buf.as_mut_ptr().cast(), buf.len(), &mut n);
        (ok != 0 && n == buf.len()).then_some(())
    };
    let word = |at: usize| {
        let mut b = [0u8; 8];
        read(at, &mut b).map(|()| usize::from_ne_bytes(b))
    };
    let params = word(peb + 0x20)?;
    let (env, size) = (word(params + 0x80)?, word(params + 0x3F0)?);
    let mut bytes = vec![0u8; size.min(1 << 20)];
    read(env, &mut bytes)?;
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_ne_bytes(*c))
        .collect();
    Some(
        units
            .split(|u| *u == 0)
            .take_while(|v| !v.is_empty())
            .map(String::from_utf16_lossy)
            .collect(),
    )
}

/// The group jobs this process made, held open so their names stay findable while any member
/// lives: a job's name goes with its last handle.
static HELD: std::sync::Mutex<Vec<(u32, u64, Handle)>> = std::sync::Mutex::new(Vec::new());

/// Keeps `job` open until it has no member left.
pub fn hold(pid: u32, start_us: u64, job: Handle) {
    let mut held = HELD.lock().unwrap();
    held.retain(|(_, _, j)| !members(j).is_empty());
    held.push((pid, start_us, job));
}

/// The start of the latest group job this process made for `pid`.
pub fn held_start(pid: u32) -> Option<u64> {
    let held = HELD.lock().unwrap();
    held.iter().rev().find(|h| h.0 == pid).map(|h| h.1)
}

pub const GROUP: &str = "g";
pub const HOST: &str = "h";

fn job_name(kind: &str, pid: u32, start_us: u64) -> Vec<u16> {
    wide(format!("Local\\brigadier-{kind}-{pid}-{start_us}"))
}

/// A new named job for `pid`. `kill_on_close`: closing its last handle ends every process in it,
/// which is how a host's work can't outlive the host.
pub fn new_job(kind: &str, pid: u32, start_us: u64, kill_on_close: bool) -> io::Result<Handle> {
    let name = job_name(kind, pid, start_us);
    let job = handle(unsafe { CreateJobObjectW(std::ptr::null(), name.as_ptr()) })
        .ok_or_else(io::Error::last_os_error)?;
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        return Err(io::Error::other(
            "A job with this process's name already exists.",
        ));
    }
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    // What an agent starts with breakaway asked for may leave, as a child leaves a group on macOS.
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK
        | if kill_on_close {
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        } else {
            0
        };
    let size = size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
    let at = (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast();
    if unsafe { SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, at, size) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

pub fn assign(job: &Handle, process: &Handle) -> io::Result<()> {
    if unsafe { AssignProcessToJobObject(job.0, process.0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Puts this process in a new job of its own.
pub fn own_job(kind: &str, kill_on_close: bool) -> io::Result<Handle> {
    // The pseudo-handle needs no closing.
    let me = std::mem::ManuallyDrop::new(Handle(unsafe { GetCurrentProcess() }));
    let start = start_us(&me).unwrap_or(0);
    let job = new_job(kind, std::process::id(), start, kill_on_close)?;
    assign(&job, &me)?;
    Ok(job)
}

pub fn open_job(kind: &str, pid: u32, start_us: u64) -> Option<Handle> {
    let name = job_name(kind, pid, start_us);
    // JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE
    let access = 4 | 8;
    handle(unsafe { OpenJobObjectW(access, 0, name.as_ptr()) })
}

/// The pids in a job now, its nested jobs' included.
pub fn members(job: &Handle) -> Vec<u32> {
    let mut room = 64;
    loop {
        // The list's two counts, then one pid per word.
        let mut buf = vec![0usize; room + 1];
        let bytes = (buf.len() * size_of::<usize>()) as u32;
        let at = buf.as_mut_ptr().cast();
        let ok = unsafe {
            QueryInformationJobObject(
                job.0,
                JobObjectBasicProcessIdList,
                at,
                bytes,
                std::ptr::null_mut(),
            )
        };
        let (assigned, listed) = (buf[0] as u32 as usize, (buf[0] >> 32) as usize);
        if ok != 0 && listed >= assigned {
            return buf[1..=listed.min(room)]
                .iter()
                .map(|p| *p as u32)
                .collect();
        }
        if room > 1 << 16 {
            return vec![];
        }
        room = (assigned + 16).max(room * 2);
    }
}

pub fn terminate(job: &Handle) -> bool {
    unsafe { TerminateJobObject(job.0, 1) != 0 }
}

/// `OBJECT_DIRECTORY_INFORMATION`, which windows-sys has no type for.
#[repr(C)]
struct Entry {
    name: UNICODE_STRING,
    kind: UNICODE_STRING,
}

/// Every live job of `kind` in this logon session's namespace, by the pid and start it names.
pub fn jobs(kind: &str) -> Vec<(u32, u64)> {
    let mut session = 0;
    unsafe { ProcessIdToSessionId(std::process::id(), &mut session) };
    let path = match session {
        0 => "\\BaseNamedObjects".to_string(),
        n => format!("\\Sessions\\{n}\\BaseNamedObjects"),
    };
    let mut path: Vec<u16> = path.encode_utf16().collect();
    let name = UNICODE_STRING {
        Length: (path.len() * 2) as u16,
        MaximumLength: (path.len() * 2) as u16,
        Buffer: path.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        ObjectName: &name,
        ..Default::default()
    };
    let mut dir = std::ptr::null_mut();
    // DIRECTORY_QUERY
    if unsafe { NtOpenDirectoryObject(&mut dir, 1, &attributes) } < 0 {
        return vec![];
    }
    let Some(dir) = handle(dir) else {
        return vec![];
    };
    let prefix = format!("brigadier-{kind}-");
    let (mut found, mut context, mut first) = (vec![], 0u32, true);
    let mut buf = vec![0u64; 8192];
    loop {
        let mut len = 0;
        let bytes = (buf.len() * 8) as u32;
        let at = buf.as_mut_ptr().cast();
        let status = unsafe {
            NtQueryDirectoryObject(dir.0, at, bytes, false, first, &mut context, &mut len)
        };
        first = false;
        if status < 0 {
            return found;
        }
        let entries = buf.as_ptr().cast::<Entry>();
        for i in 0.. {
            let e = unsafe { &*entries.add(i) };
            if e.name.Buffer.is_null() {
                break;
            }
            let text = unsafe {
                std::slice::from_raw_parts(e.name.Buffer, usize::from(e.name.Length) / 2)
            };
            let text = String::from_utf16_lossy(text);
            if let Some((pid, start)) = text.strip_prefix(&prefix).and_then(|t| t.split_once('-'))
                && let (Ok(pid), Ok(start)) = (pid.parse(), start.parse())
            {
                found.push((pid, start));
            }
        }
        // STATUS_MORE_ENTRIES: the buffer was full.
        if status != 0x105 {
            return found;
        }
    }
}
