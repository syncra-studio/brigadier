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
