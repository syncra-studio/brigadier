//! Pipes and a PTY on Unix.

use crate::log;
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

// TIOCSCTTY isn't exported by libc for Apple targets; _IO('t', 97).
#[cfg(target_os = "macos")]
const TIOCSCTTY: libc::c_ulong = 0x2000_7461;
#[cfg(target_os = "linux")]
use libc::TIOCSCTTY;

pub type Child = std::process::Child;
/// What the parent writes to the child: its stdin pipe, or the PTY's master.
pub type Input = File;
pub type Spawned = (Child, Option<Input>, Vec<(u8, File)>);

pub fn spawn_pipes(command: &mut Command, keep_stdin: bool) -> io::Result<Spawned> {
    command
        .stdin(if keep_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.process_group(0);
    let mut child = crate::procs::spawn(command)?;
    let file = |fd: OwnedFd| File::from(fd);
    let input = child.stdin.take().map(|s| file(s.into()));
    let out = file(child.stdout.take().expect("piped").into());
    let err = file(child.stderr.take().expect("piped").into());
    Ok((child, input, vec![(log::OUT, out), (log::ERR, err)]))
}

pub fn spawn_pty(command: &mut Command, cols: u16, rows: u16) -> io::Result<Spawned> {
    let (mut master, mut slave) = (0, 0);
    let mut size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    if unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &raw mut size,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    // openpty's fds aren't close-on-exec: without this, every later child inherits this terminal
    // and keeps it open after its owner dies.
    for fd in [master, slave] {
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
    let master = unsafe { File::from_raw_fd(master) };
    let slave = unsafe { File::from_raw_fd(slave) };
    command
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave));
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 || libc::ioctl(0, TIOCSCTTY, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = crate::procs::spawn(command)?;
    // The parent's slave copies were moved into `command` and close when it drops.
    Ok((child, Some(master.try_clone()?), vec![(log::PTY, master)]))
}

/// Sets a PTY's size through its master; the kernel tells the child with SIGWINCH.
pub fn resize(master: &File, cols: u16, rows: u16) -> io::Result<()> {
    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    if unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &size) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Starts a short-lived helper (a probe, a writer, a sign-in) in a process group of its own.
/// `kill_tree` ends it and all it started.
pub fn grouped(command: &mut Command) -> io::Result<Child> {
    crate::procs::spawn(command.process_group(0))
}

/// `grouped`, in a session of its own: no terminal, so a probe started from one (an interactive
/// login shell) can't stop there waiting for the foreground. Its group is still its pid.
pub fn alone(command: &mut Command) -> io::Result<Child> {
    unsafe {
        command.pre_exec(|| match libc::setsid() < 0 {
            true => Err(io::Error::last_os_error()),
            false => Ok(()),
        })
    };
    crate::procs::spawn(command)
}

/// KILL for a `grouped` child's whole group, its own exit notwithstanding.
pub fn kill_tree(pid: u32) {
    unsafe { libc::killpg(pid as i32, libc::SIGKILL) };
}

/// Starts `command` in a session of its own: no terminal, and no signal to whoever started it
/// reaches it.
pub fn detached(command: &mut Command) -> io::Result<std::process::Child> {
    unsafe {
        command.pre_exec(|| match libc::setsid() < 0 {
            true => Err(io::Error::last_os_error()),
            false => Ok(()),
        })
    };
    command.spawn()
}
