//! The file facts core reads that each system gives its own way: a file's identity, positional
//! reads and writes, a write stamp, and on Windows a directory junction and the registry's environment.

use std::fs::{File, Metadata};
use std::io;
use std::path::Path;

/// The file at `path` itself (a link, not what it points to), as its disk and the disk's number
/// for it: the same pair for one file under any name.
#[cfg(unix)]
pub fn file_id(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::symlink_metadata(path).ok()?;
    Some((m.dev(), m.ino()))
}

#[cfg(windows)]
pub fn file_id(path: &Path) -> Option<(u64, u64)> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let file = std::fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .ok()?;
    open_id(&file)
}

/// `file_id` of a file already open.
#[cfg(unix)]
pub fn open_id(file: &File) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = file.metadata().ok()?;
    Some((m.dev(), m.ino()))
}

#[cfg(windows)]
pub fn open_id(file: &File) -> Option<(u64, u64)> {
    let i = info(file)?;
    let index = (u64::from(i.nFileIndexHigh) << 32) | u64::from(i.nFileIndexLow);
    Some((u64::from(i.dwVolumeSerialNumber), index))
}

#[cfg(windows)]
fn info(
    file: &File,
) -> Option<windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
    let mut i = unsafe { std::mem::zeroed() };
    (unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut i) } != 0).then_some(i)
}

/// The space a file takes on disk: its blocks, or on Windows its length.
pub fn disk_bytes(m: &Metadata) -> u64 {
    #[cfg(unix)]
    return std::os::unix::fs::MetadataExt::blocks(m) * 512;
    #[cfg(windows)]
    return m.len();
}

/// How many names the file has, and who it is, so one with several is counted once. On Windows
/// a walk can't cheaply tell: one name each.
pub fn names(m: &Metadata) -> (u64, (u64, u64)) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (m.nlink(), (m.dev(), m.ino()))
    }
    #[cfg(windows)]
    {
        let _ = m;
        (1, (0, 0))
    }
}

/// Bytes free to this user on the disk holding `path`.
#[cfg(unix)]
// f_bavail is 32 bits on macOS, 64 on Linux.
#[allow(clippy::unnecessary_cast)]
pub fn free_bytes(path: &Path) -> Option<u64> {
    let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).ok()?;
    let mut s = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
    if unsafe { libc::statvfs(c.as_ptr(), s.as_mut_ptr()) } != 0 {
        return None;
    }
    let s = unsafe { s.assume_init() };
    Some(s.f_bavail as u64 * s.f_frsize as u64)
}

#[cfg(windows)]
pub fn free_bytes(path: &Path) -> Option<u64> {
    let mut free = 0;
    let path = brigadier_frames::win::wide(path);
    let ok = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut free,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(free)
}

/// `secs` since 1970 in local time.
pub fn local_time(secs: i64) -> libc::tm {
    let secs = secs as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    #[cfg(unix)]
    unsafe {
        libc::localtime_r(&secs, &mut tm)
    };
    #[cfg(windows)]
    unsafe {
        libc::localtime_s(&mut tm, &secs)
    };
    tm
}

/// When the file was last written, to the nanosecond, and its size: equal only while unchanged.
pub fn stamp(m: &Metadata) -> String {
    let at = (m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .unwrap_or_default();
    format!("{}.{:09}:{}", at.as_secs(), at.subsec_nanos(), m.len())
}

#[cfg(unix)]
pub fn read_exact_at(file: &File, buf: &mut [u8], at: u64) -> io::Result<()> {
    std::os::unix::fs::FileExt::read_exact_at(file, buf, at)
}

/// Windows' positional read also moves the file's cursor, which nothing here reads by.
#[cfg(windows)]
pub fn read_exact_at(file: &File, mut buf: &mut [u8], mut at: u64) -> io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        match file.seek_read(buf, at) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => {
                buf = &mut buf[n..];
                at += n as u64;
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

#[cfg(unix)]
pub fn write_all_at(file: &File, buf: &[u8], at: u64) -> io::Result<()> {
    std::os::unix::fs::FileExt::write_all_at(file, buf, at)
}

#[cfg(windows)]
pub fn write_all_at(file: &File, mut buf: &[u8], mut at: u64) -> io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        match file.seek_write(buf, at) {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(n) => {
                buf = &buf[n..];
                at += n as u64;
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Makes `link` a directory junction to `target`, which needs no privilege, as a symlink does
/// without Developer Mode. `target` is made absolute; `link` must not exist yet.
#[cfg(windows)]
pub fn junction(target: &Path, link: &Path) -> io::Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;
    const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    let target = std::path::absolute(target)?;
    let mut print: Vec<u16> = target.as_os_str().encode_wide().collect();
    // A canonical path's \\?\ goes: the kernel's name has its own prefix.
    if print.starts_with(&[92, 92, 63, 92]) {
        print.drain(..4);
    }
    let sub: Vec<u16> = OsStr::new(r"\??\")
        .encode_wide()
        .chain(print.iter().copied())
        .collect();
    // The mount point's names, each NUL-ended: the kernel's, then the one shown.
    let names: Vec<u16> = (sub.iter().chain([&0]).chain(&print).chain([&0]))
        .copied()
        .collect();
    let (sub_len, print_len) = (sub.len() * 2, print.len() * 2);
    let data_len = u16::try_from(8 + names.len() * 2).map_err(io::Error::other)?;
    let mut buf: Vec<u8> = vec![];
    buf.extend(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buf.extend(data_len.to_le_bytes());
    buf.extend([0, 0]);
    for n in [0, sub_len, sub_len + 2, print_len] {
        buf.extend((n as u16).to_le_bytes());
    }
    buf.extend(names.iter().flat_map(|c| c.to_le_bytes()));
    std::fs::create_dir(link)?;
    let set = std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(link)
        .and_then(|dir| {
            let mut got = 0;
            let ok = unsafe {
                DeviceIoControl(
                    dir.as_raw_handle(),
                    FSCTL_SET_REPARSE_POINT,
                    buf.as_ptr().cast(),
                    buf.len() as u32,
                    std::ptr::null_mut(),
                    0,
                    &mut got,
                    std::ptr::null_mut(),
                )
            };
            (ok != 0).then_some(()).ok_or_else(io::Error::last_os_error)
        });
    if set.is_err() {
        let _ = std::fs::remove_dir(link);
    }
    set
}

/// A variable as new processes get it: (the machine's, the user's), from the registry, expanded.
/// An install changes these, which a running process's own environment never sees.
#[cfg(windows)]
pub fn registry_env(name: &str) -> (Option<String>, Option<String>) {
    use brigadier_frames::win::wide;
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
        RegGetValueW,
    };
    let get = |root: HKEY, key: &str| {
        let (key, value) = (wide(key), wide(name));
        let mut buf = vec![0u16; 512];
        // Twice at most: the first call names the size when the buffer is too small.
        for _ in 0..2 {
            let mut len = (buf.len() * 2) as u32;
            let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
            let ptr = buf.as_mut_ptr().cast();
            let null = std::ptr::null_mut();
            let got = unsafe {
                RegGetValueW(
                    root,
                    key.as_ptr(),
                    value.as_ptr(),
                    flags,
                    null,
                    ptr,
                    &mut len,
                )
            };
            if got == 0 {
                let text = String::from_utf16_lossy(&buf[..len as usize / 2]);
                return Some(text.trim_end_matches('\0').to_string()).filter(|t| !t.is_empty());
            }
            buf.resize(len as usize / 2 + 1, 0);
        }
        None
    };
    let machine = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";
    (
        get(HKEY_LOCAL_MACHINE, machine),
        get(HKEY_CURRENT_USER, "Environment"),
    )
}
