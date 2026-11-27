//! `brigadier-remote`, the phone gateway: unix.rs. Remote access stays macOS's for now.

#[cfg(unix)]
mod unix;

#[cfg(unix)]
fn main() {
    unix::main()
}

#[cfg(not(unix))]
fn main() {
    eprintln!("brigadier-remote: remote access isn't on this system yet.");
    std::process::exit(1)
}
