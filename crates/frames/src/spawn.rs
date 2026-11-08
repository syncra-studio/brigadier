//! Starting a child on pipes or on a PTY, and sizing a PTY. Nothing here knows what runs.

use crate::log;
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

// TIOCSCTTY isn't exported by libc for Apple targets; _IO('t', 97).
const TIOCSCTTY: libc::c_ulong = 0x2000_7461;

pub type Spawned = (std::process::Child, Option<File>, Vec<(u8, File)>);

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
    let mut child = command.spawn()?;
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
            &mut size,
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
    let child = command.spawn()?;
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
