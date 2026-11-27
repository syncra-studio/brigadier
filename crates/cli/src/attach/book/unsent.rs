//! The mark on an error raised before any host was asked to take a message.

use std::io;

/// An error before any host was asked to take the message: it surely never went.
#[derive(Debug)]
struct Unsent(String);

impl std::fmt::Display for Unsent {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Unsent {}

pub(crate) fn unsent(e: io::Error) -> io::Error {
    io::Error::new(e.kind(), Unsent(e.to_string()))
}

pub(crate) fn is_unsent(e: &io::Error) -> bool {
    e.get_ref().is_some_and(|inner| inner.is::<Unsent>())
}
