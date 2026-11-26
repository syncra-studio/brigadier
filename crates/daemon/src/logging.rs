use std::fs::File;
use std::io::{self, Seek};

pub fn trim(output: &mut File) -> io::Result<()> {
    let meta = output.metadata()?;
    if meta.is_file() && meta.len() >= 5 * 1024 * 1024 {
        output.set_len(0)?;
        // An inherited stderr may not be append-only: reset its shared offset too.
        output.rewind()?;
    }
    Ok(())
}
