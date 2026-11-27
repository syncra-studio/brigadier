//! Pipes and ConPTY on Windows. Every child starts suspended and is put in a named job of its own
//! (crate::win), its group, before it runs a single instruction; `go` lets it run. A host that
//! dies first takes the suspended child with it through its own job [D60].
//!
//! ConPTY dies with the process that made it, so the host owns it. Its output is drained while
//! ClosePseudoConsole runs, which blocks until then before Windows 11 24H2 (PLAN.md step 10).

use crate::log;
use crate::win::{self, GROUP, Handle};
use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Write};
use std::mem::{size_of, zeroed};
use std::os::windows::io::{FromRawHandle, IntoRawHandle, OwnedHandle};
use std::os::windows::process::{CommandExt, ExitStatusExt};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
};

/// A pseudoconsole, closed once: by the child's wait, or when the last user lets go.
pub struct Pty(Mutex<Option<HPCON>>);

impl Pty {
    fn close(&self) {
        if let Some(h) = self.0.lock().unwrap().take() {
            unsafe { ClosePseudoConsole(h) };
        }
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        self.close();
    }
}

/// What the parent writes to the child: its stdin pipe, or the pseudoconsole's input.
pub struct Input {
    file: File,
    pty: Option<Arc<Pty>>,
}

impl Input {
    pub fn try_clone(&self) -> io::Result<Input> {
        Ok(Input {
            file: self.file.try_clone()?,
            pty: self.pty.clone(),
        })
    }
}

impl Write for Input {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.file.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

pub struct Child {
    pid: u32,
    process: Handle,
    pty: Option<Arc<Pty>>,
}

impl Child {
    pub fn id(&self) -> u32 {
        self.pid
    }

    /// Lets the suspended child run.
    pub fn go(&self) -> io::Result<()> {
        win::resume(self.pid)
    }

    /// Waits for it to exit, then closes its pseudoconsole, so its output ends once drained.
    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        if unsafe { WaitForSingleObject(self.process.0, INFINITE) } != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        self.status()
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        match unsafe { WaitForSingleObject(self.process.0, 0) } {
            WAIT_OBJECT_0 => self.status().map(Some),
            WAIT_TIMEOUT => Ok(None),
            _ => Err(io::Error::last_os_error()),
        }
    }

    fn status(&mut self) -> io::Result<ExitStatus> {
        if let Some(pty) = &self.pty {
            pty.close();
        }
        let mut code = 0;
        if unsafe { GetExitCodeProcess(self.process.0, &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(ExitStatus::from_raw(code))
    }
}

pub type Spawned = (Child, Option<Input>, Vec<(u8, File)>);

/// Puts a just-started, suspended process in a group job named after it.
fn grouped_job(pid: u32, process: &Handle) -> io::Result<()> {
    let start = win::start_us(process).ok_or_else(io::Error::last_os_error)?;
    let job = win::new_job(GROUP, pid, start, false)?;
    win::assign(&job, process)?;
    win::hold(pid, start, job);
    Ok(())
}

fn own(handle: OwnedHandle) -> Handle {
    Handle(handle.into_raw_handle())
}

/// Starts `command` suspended, in its own group job, on pipes. `go` lets it run.
pub fn spawn_pipes(command: &mut Command, keep_stdin: bool) -> io::Result<Spawned> {
    command
        .stdin(if keep_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
    let mut child = command.spawn()?;
    let file = |h: OwnedHandle| File::from(h);
    let input = (child.stdin.take()).map(|s| Input {
        file: file(s.into()),
        pty: None,
    });
    let out = file(child.stdout.take().expect("piped").into());
    let err = file(child.stderr.take().expect("piped").into());
    let pid = child.id();
    let process = own(child.into());
    if let Err(e) = grouped_job(pid, &process) {
        unsafe { windows_sys::Win32::System::Threading::TerminateProcess(process.0, 1) };
        return Err(e);
    }
    let child = Child {
        pid,
        process,
        pty: None,
    };
    Ok((child, input, vec![(log::OUT, out), (log::ERR, err)]))
}

/// One argument as the C runtime reads it back: quoted when it must be, backslashes doubled only
/// before a quote.
fn quote(arg: &OsStr, out: &mut String) {
    let arg = arg.to_string_lossy();
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        out.push_str(&arg);
        return;
    }
    out.push('"');
    let mut slashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            c => {
                out.extend(std::iter::repeat_n('\\', slashes));
                out.push(c);
                slashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', slashes * 2));
    out.push('"');
}

fn pipe() -> io::Result<(Handle, Handle)> {
    let (mut read, mut write) = (std::ptr::null_mut(), std::ptr::null_mut());
    if unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((Handle(read), Handle(write)))
}

fn coord(cols: u16, rows: u16) -> COORD {
    COORD {
        X: cols as i16,
        Y: rows as i16,
    }
}

/// Starts `command` suspended on a new pseudoconsole, in its own group job. Its environment is
/// only what `command` sets, as the runner's `env_clear` asks. `go` lets it run.
pub fn spawn_pty(command: &mut Command, cols: u16, rows: u16) -> io::Result<Spawned> {
    let (in_read, in_write) = pipe()?;
    let (out_read, out_write) = pipe()?;
    let mut hpc: HPCON = 0;
    let made =
        unsafe { CreatePseudoConsole(coord(cols, rows), in_read.0, out_write.0, 0, &mut hpc) };
    if made < 0 {
        return Err(io::Error::from_raw_os_error(made));
    }
    // The pseudoconsole holds its own copies of these ends.
    drop((in_read, out_write));
    let pty = Arc::new(Pty(Mutex::new(Some(hpc))));

    let mut size = 0;
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
    let mut list = vec![0u8; size];
    let attrs = list.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
    if unsafe { InitializeProcThreadAttributeList(attrs, 1, 0, &mut size) } == 0
        || unsafe {
            UpdateProcThreadAttribute(
                attrs,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                hpc as *const _,
                size_of::<HPCON>(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut info: STARTUPINFOEXW = unsafe { zeroed() };
    info.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    // No std handles of ours: the child's come from the pseudoconsole.
    info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    info.lpAttributeList = attrs;

    let mut line = String::new();
    quote(command.get_program(), &mut line);
    for arg in command.get_args() {
        line.push(' ');
        quote(arg, &mut line);
    }
    let mut line = win::wide(line);
    let mut env: Vec<(String, String)> = (command.get_envs())
        .filter_map(|(k, v)| Some((k.to_string_lossy().into(), v?.to_string_lossy().into())))
        .collect();
    env.sort_by_key(|(k, _)| k.to_uppercase());
    let mut block: Vec<u16> = env
        .iter()
        .flat_map(|(k, v)| format!("{k}={v}\0").encode_utf16().collect::<Vec<_>>())
        .collect();
    block.extend([0, 0]);
    let path = env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH"));
    let cwd = command
        .get_current_dir()
        .map(|d| d.to_string_lossy().into_owned());
    let program = command.get_program().to_string_lossy().into_owned();
    let exe = crate::procs::find(
        &program,
        path.map(|p| p.1.as_str()),
        cwd.as_deref().unwrap_or("."),
    )
    .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
    let exe = win::wide(exe);
    let cwd = cwd.map(win::wide);
    let mut pi: PROCESS_INFORMATION = unsafe { zeroed() };
    let flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED;
    let ok = unsafe {
        CreateProcessW(
            exe.as_ptr(),
            line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            flags,
            block.as_ptr().cast(),
            cwd.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
            &info.StartupInfo,
            &mut pi,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    drop(Handle(pi.hThread));
    let process = Handle(pi.hProcess);
    if let Err(e) = grouped_job(pi.dwProcessId, &process) {
        unsafe { windows_sys::Win32::System::Threading::TerminateProcess(process.0, 1) };
        return Err(e);
    }
    let file = |h: Handle| unsafe { File::from_raw_handle(std::mem::ManuallyDrop::new(h).0) };
    let input = Input {
        file: file(in_write),
        pty: Some(pty.clone()),
    };
    let child = Child {
        pid: pi.dwProcessId,
        process,
        pty: Some(pty),
    };
    Ok((child, Some(input), vec![(log::PTY, file(out_read))]))
}

/// Sets the pseudoconsole's size; the console tells the child.
pub fn resize(input: &Input, cols: u16, rows: u16) -> io::Result<()> {
    let pty = input
        .pty
        .as_ref()
        .ok_or_else(|| io::Error::other("not a terminal"))?;
    let Some(h) = *pty.0.lock().unwrap() else {
        return Err(io::Error::other("The terminal has closed."));
    };
    let r = unsafe { ResizePseudoConsole(h, coord(cols, rows)) };
    (r >= 0)
        .then_some(())
        .ok_or_else(|| io::Error::from_raw_os_error(r))
}

/// Starts a short-lived helper (a probe, a writer, a sign-in) in a group job of its own, running
/// at once and with no console window. `kill_tree` ends it and all it started.
pub fn grouped(command: &mut Command) -> io::Result<std::process::Child> {
    command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
    let child = command.spawn()?;
    let pid = child.id();
    let process = win::open(pid, PROCESS_ALL).ok_or_else(io::Error::last_os_error)?;
    let started = grouped_job(pid, &process).and_then(|()| win::resume(pid));
    if let Err(e) = started {
        unsafe { windows_sys::Win32::System::Threading::TerminateProcess(process.0, 1) };
        return Err(e);
    }
    Ok(child)
}

const PROCESS_ALL: u32 = windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION
    | windows_sys::Win32::System::Threading::PROCESS_TERMINATE
    | windows_sys::Win32::System::Threading::PROCESS_SET_QUOTA;

/// Ends a child started here and everything in its group, its own exit notwithstanding.
pub fn kill_tree(pid: u32) {
    if let Some(start) = win::held_start(pid) {
        crate::procs::kill_group(pid as i32, start);
    }
}

/// Starts `command` out of every job and console this process is in, so nothing that ends them
/// ends it; a job around it that forbids leaving is named as the reason.
pub fn detached(command: &mut Command) -> io::Result<std::process::Child> {
    use windows_sys::Win32::System::Threading::{
        CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS,
    };
    command.creation_flags(DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP);
    command.spawn().map_err(|e| match e.raw_os_error() {
        // ERROR_ACCESS_DENIED: a job around this process doesn't let its children leave.
        Some(5) => io::Error::other(
            "Brigadier couldn't start on its own: the program that started it holds its children in a job they can't leave. Start Brigadier from the Start menu instead.",
        ),
        _ => e,
    })
}
