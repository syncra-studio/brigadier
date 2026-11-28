//! Starting a child on pipes or on a terminal, and sizing the terminal. Nothing here knows what
//! runs.

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

/// `Command::new` that opens no console window on Windows: the daemon and hosts have no console,
/// so a console program they start plainly gets a window of its own.
pub fn windowless(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(
        &mut command,
        windows_sys::Win32::System::Threading::CREATE_NO_WINDOW,
    );
    command
}
