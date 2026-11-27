//! Named pipes, Windows' local sockets (PLAN.md step 10). A socket path names its pipe:
//! `<data>/daemon.sock` is `\\.\pipe\brigadier-<hash>-daemon` and `<data>/sessions/<id>/s` is
//! `…-s-<id>`, `<hash>` the first 16 hex digits of SHA-256 of the data folder's path as given, as
//! the drill computes it (D172, proposed). No file is made, so none goes stale.
//!
//! The first instance is made with FILE_FLAG_FIRST_PIPE_INSTANCE, which fails while any instance
//! lives, so only one owner can serve a name; the next one always exists before a connected one is
//! handed on. Only this user may open the pipe (its DACL), remote clients are refused, and each
//! client's token is checked against ours, as the peer's uid is on Unix.

use crate::win::{Handle, wide};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use std::mem::{size_of, zeroed};
use std::net::Shutdown;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use windows_sys::Win32::Foundation::{
    DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_ACCESS_DENIED, ERROR_BROKEN_PIPE,
    ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING, ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY,
    ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, GetLastError,
    HANDLE, INVALID_HANDLE_VALUE, LocalFree, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    EqualSid, GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
    TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
    PIPE_ACCESS_DUPLEX, ReadFile, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT, WriteFile,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
    GetNamedPipeServerProcessId, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT, WaitNamedPipeW,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, INFINITE, OpenProcessToken, WaitForSingleObject,
};

/// The pipe a socket path stands for.
pub fn pipe_name(path: &Path) -> io::Result<String> {
    let bad = || io::Error::other(format!("No local socket is named {}.", path.display()));
    let parent = path.parent().ok_or_else(bad)?;
    let (data, tail) = match path.file_name().and_then(|n| n.to_str()) {
        Some("daemon.sock") => (parent, "daemon".to_string()),
        Some("s") => {
            let id = parent
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(bad)?;
            (
                parent.parent().and_then(Path::parent).ok_or_else(bad)?,
                format!("s-{id}"),
            )
        }
        _ => return Err(bad()),
    };
    let hash = Sha256::digest(data.to_string_lossy().as_bytes());
    let hex: String = hash[..8].iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(r"\\.\pipe\brigadier-{hex}-{tail}"))
}

/// One end of a connected pipe. Reads and writes are overlapped, so each can time out as a
/// socket's would, and one thread may read while another writes.
pub struct Stream {
    pipe: Handle,
    server: bool,
    read_ms: AtomicU64,
    write_ms: AtomicU64,
    closed: Arc<AtomicBool>,
}

fn last() -> io::Error {
    io::Error::last_os_error()
}

fn ms(timeout: Option<Duration>) -> u64 {
    timeout.map_or(0, |t| {
        t.as_millis().clamp(1, u64::from(INFINITE - 1) as u128) as u64
    })
}

impl Stream {
    fn new(pipe: Handle, server: bool) -> Stream {
        Stream {
            pipe,
            server,
            read_ms: AtomicU64::new(0),
            write_ms: AtomicU64::new(0),
            closed: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.read_ms.store(ms(timeout), Ordering::SeqCst);
        Ok(())
    }

    pub fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> {
        self.write_ms.store(ms(timeout), Ordering::SeqCst);
        Ok(())
    }

    pub fn try_clone(&self) -> io::Result<Stream> {
        let me = unsafe { GetCurrentProcess() };
        let mut copy = std::ptr::null_mut();
        if unsafe { DuplicateHandle(me, self.pipe.0, me, &mut copy, 0, 0, DUPLICATE_SAME_ACCESS) }
            == 0
        {
            return Err(last());
        }
        Ok(Stream {
            pipe: Handle(copy),
            server: self.server,
            read_ms: AtomicU64::new(self.read_ms.load(Ordering::SeqCst)),
            write_ms: AtomicU64::new(self.write_ms.load(Ordering::SeqCst)),
            closed: self.closed.clone(),
        })
    }

    /// Ends the connection for every clone: pending reads and writes fail, later ones too.
    pub fn shutdown(&self, _how: Shutdown) -> io::Result<()> {
        self.closed.store(true, Ordering::SeqCst);
        unsafe { CancelIoEx(self.pipe.0, std::ptr::null()) };
        if self.server {
            unsafe { DisconnectNamedPipe(self.pipe.0) };
        }
        Ok(())
    }

    fn io(&self, read: bool, at: *mut u8, len: usize, timeout_ms: u64) -> io::Result<usize> {
        if self.closed.load(Ordering::SeqCst) {
            return if read {
                Ok(0)
            } else {
                Err(io::ErrorKind::BrokenPipe.into())
            };
        }
        let event =
            crate::win::handle(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) })
                .ok_or_else(last)?;
        let mut ov: OVERLAPPED = unsafe { zeroed() };
        ov.hEvent = event.0;
        let len = len.min(u32::MAX as usize) as u32;
        let started = unsafe {
            match read {
                true => ReadFile(self.pipe.0, at, len, std::ptr::null_mut(), &mut ov),
                false => WriteFile(self.pipe.0, at, len, std::ptr::null_mut(), &mut ov),
            }
        };
        if started == 0 {
            let error = unsafe { GetLastError() };
            if error != ERROR_IO_PENDING {
                return ended(read, error);
            }
            let wait = if timeout_ms == 0 {
                INFINITE
            } else {
                timeout_ms as u32
            };
            if unsafe { WaitForSingleObject(event.0, wait) } == WAIT_TIMEOUT {
                let mut n = 0;
                unsafe {
                    CancelIoEx(self.pipe.0, &ov);
                    GetOverlappedResult(self.pipe.0, &ov, &mut n, 1);
                }
                return Err(io::ErrorKind::TimedOut.into());
            }
        }
        let mut n = 0;
        if unsafe { GetOverlappedResult(self.pipe.0, &ov, &mut n, 1) } == 0 {
            return ended(read, unsafe { GetLastError() });
        }
        Ok(n as usize)
    }
}

/// A closed pipe is the end of a read, as a socket's EOF is.
fn ended(read: bool, error: u32) -> io::Result<usize> {
    match error {
        ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED | ERROR_OPERATION_ABORTED if read => Ok(0),
        e => Err(io::Error::from_raw_os_error(e as i32)),
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let ms = self.read_ms.load(Ordering::SeqCst);
        self.io(true, buf.as_mut_ptr(), buf.len(), ms)
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let ms = self.write_ms.load(Ordering::SeqCst);
        self.io(false, buf.as_ptr().cast_mut(), buf.len(), ms)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// This user's SID, as the token gives it.
fn user_of(token: HANDLE) -> io::Result<Vec<u8>> {
    let mut size = 0;
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size) };
    let mut buf = vec![0u8; size as usize];
    if unsafe { GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), size, &mut size) }
        == 0
    {
        return Err(last());
    }
    Ok(buf)
}

fn sid(buf: &[u8]) -> *mut core::ffi::c_void {
    unsafe { (*buf.as_ptr().cast::<TOKEN_USER>()).User.Sid }
}

fn my_user() -> io::Result<Vec<u8>> {
    process_user(unsafe { GetCurrentProcess() })
}

/// The user a process runs as, by its token.
fn process_user(process: HANDLE) -> io::Result<Vec<u8>> {
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(last());
    }
    user_of(Handle(token).0)
}

/// The other end runs as this user: its process's token names our SID. Impersonating it would say
/// the same, but only once something has been read from the pipe, and the daemon checks first.
pub fn same_user(stream: &Stream) -> io::Result<bool> {
    use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
    let pid = peer_pid(stream)? as u32;
    let process = crate::win::open(pid, PROCESS_QUERY_LIMITED_INFORMATION).ok_or_else(last)?;
    let (theirs, mine) = (process_user(process.0)?, my_user()?);
    Ok(unsafe { EqualSid(sid(&theirs), sid(&mine)) } != 0)
}

/// The pid of the other end: the client that connected, or on a client's stream the listener.
pub fn peer_pid(stream: &Stream) -> io::Result<i32> {
    let mut pid = 0;
    let of = match stream.server {
        true => GetNamedPipeClientProcessId,
        false => GetNamedPipeServerProcessId,
    };
    if unsafe { of(stream.pipe.0, &mut pid) } == 0 {
        return Err(last());
    }
    Ok(pid as i32)
}

/// A security descriptor that lets only this user in.
struct Owner(PSECURITY_DESCRIPTOR);
unsafe impl Send for Owner {}
unsafe impl Sync for Owner {}
impl Drop for Owner {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

fn owner_only() -> io::Result<Owner> {
    let mine = my_user()?;
    let mut text = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid(&mine), &mut text) } == 0 {
        return Err(last());
    }
    let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
    let user = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
    unsafe { LocalFree(text.cast()) };
    let sddl = wide(format!("D:P(A;;GA;;;{user})"));
    let mut sd = std::ptr::null_mut();
    let made = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut sd,
            std::ptr::null_mut(),
        )
    };
    if made == 0 {
        return Err(last());
    }
    Ok(Owner(sd))
}

pub struct Listener {
    name: Vec<u16>,
    owner: Owner,
    next: Mutex<Option<Handle>>,
}

fn instance(name: &[u16], owner: &Owner, first: bool) -> io::Result<Handle> {
    let sa = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: owner.0,
        bInheritHandle: 0,
    };
    let flags = PIPE_ACCESS_DUPLEX
        | FILE_FLAG_OVERLAPPED
        | if first {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        };
    let mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
    let h = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            flags,
            mode,
            PIPE_UNLIMITED_INSTANCES,
            64 << 10,
            64 << 10,
            0,
            &sa,
        )
    };
    if h == INVALID_HANDLE_VALUE {
        let e = unsafe { GetLastError() };
        if first && e == ERROR_ACCESS_DENIED {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                "Another process already serves this pipe.",
            ));
        }
        return Err(io::Error::from_raw_os_error(e as i32));
    }
    Ok(Handle(h))
}

/// Serves the pipe `path` names. Call only while holding the lock that owns it; the first
/// instance's flag refuses a second owner anyway.
pub fn bind(path: &Path) -> io::Result<Listener> {
    let name = wide(pipe_name(path)?);
    let owner = owner_only()?;
    let first = instance(&name, &owner, true)?;
    Ok(Listener {
        name,
        owner,
        next: Mutex::new(Some(first)),
    })
}

impl Listener {
    /// The next client, once it connects.
    pub fn accept(&self) -> io::Result<Stream> {
        let mut next = self.next.lock().unwrap();
        let pipe = match next.take() {
            Some(p) => p,
            None => instance(&self.name, &self.owner, false)?,
        };
        let event =
            crate::win::handle(unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) })
                .ok_or_else(last)?;
        let mut ov: OVERLAPPED = unsafe { zeroed() };
        ov.hEvent = event.0;
        if unsafe { ConnectNamedPipe(pipe.0, &mut ov) } == 0 {
            match unsafe { GetLastError() } {
                ERROR_PIPE_CONNECTED => {}
                ERROR_IO_PENDING => {
                    let mut n = 0;
                    if unsafe { WaitForSingleObject(event.0, INFINITE) } != WAIT_OBJECT_0
                        || unsafe { GetOverlappedResult(pipe.0, &ov, &mut n, 1) } == 0
                    {
                        return Err(last());
                    }
                }
                e => return Err(io::Error::from_raw_os_error(e as i32)),
            }
        }
        // The next instance exists before this one is handed on, so the name is never free.
        *next = Some(instance(&self.name, &self.owner, false)?);
        Ok(Stream::new(pipe, true))
    }

    pub fn incoming(&self) -> impl Iterator<Item = io::Result<Stream>> + '_ {
        std::iter::repeat_with(|| self.accept())
    }
}

/// Opens the pipe `path` names, waiting a little while every instance is busy.
pub fn connect_socket(path: &Path) -> io::Result<Stream> {
    let name = wide(pipe_name(path)?);
    for _ in 0..50 {
        let h = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                std::ptr::null_mut(),
            )
        };
        if h != INVALID_HANDLE_VALUE {
            return Ok(Stream::new(Handle(h), false));
        }
        match unsafe { GetLastError() } {
            ERROR_PIPE_BUSY => unsafe {
                WaitNamedPipeW(name.as_ptr(), 100);
            },
            // As a socket file that isn't there is.
            ERROR_FILE_NOT_FOUND => return Err(io::ErrorKind::NotFound.into()),
            e => return Err(io::Error::from_raw_os_error(e as i32)),
        }
    }
    Err(io::ErrorKind::TimedOut.into())
}
