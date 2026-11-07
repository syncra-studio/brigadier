//! Append-only frame log, one per session. A frame is `magic | len u32 | ts_ms u64 | kind u8 | data`.
//! Only the session's owner writes; anyone may read, and a reader never blocks the writer.

use std::fs::{File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAGIC: [u8; 4] = *b"BRG1";
pub const HEADER: u64 = 17;
const MAX_FRAME: u32 = 256 << 20;

pub const OUT: u8 = 1;
pub const ERR: u8 = 2;
pub const PTY: u8 = 3;
pub const INTENT: u8 = 10;
pub const DELIVERED: u8 = 11;
pub const SPAWNED: u8 = 12;
pub const EXITED: u8 = 13;
pub const STOPPED: u8 = 14;
pub const NOTE: u8 = 15;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Debug)]
pub struct Frame {
    pub seq: u64,
    pub offset: u64,
    pub ts: u64,
    pub kind: u8,
    pub data: Vec<u8>,
}

fn parse_header(h: &[u8; HEADER as usize]) -> Option<(u32, u64, u8)> {
    if h[..4] != MAGIC {
        return None;
    }
    let len = u32::from_le_bytes(h[4..8].try_into().ok()?);
    let ts = u64::from_le_bytes(h[8..16].try_into().ok()?);
    (len <= MAX_FRAME).then_some((len, ts, h[16]))
}

pub struct Writer {
    file: File,
    pub len: u64,
    pub frames: u64,
}

impl Writer {
    /// Opens for append. A torn last frame (the owner died mid-write) is cut off, so the log stays
    /// a clean sequence. Only call this while holding the session lock.
    pub fn open(path: &Path) -> io::Result<Writer> {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(path)?;
        let size = file.metadata()?.len();
        let mut reader = BufReader::with_capacity(1 << 16, file.try_clone()?);
        let (mut pos, mut frames) = (0u64, 0u64);
        let mut header = [0u8; HEADER as usize];
        while pos + HEADER <= size {
            reader.read_exact(&mut header)?;
            let Some((len, _, _)) = parse_header(&header) else {
                break;
            };
            if pos + HEADER + len as u64 > size {
                break;
            }
            reader.seek_relative(len as i64)?;
            pos += HEADER + len as u64;
            frames += 1;
        }
        if pos != size {
            file.set_len(pos)?;
        }
        Ok(Writer {
            file,
            len: pos,
            frames,
        })
    }

    /// Appends one frame. On a failed write (disk full) the partial frame is cut off again, so the
    /// log never holds a torn frame in the middle. `sync` makes it durable before returning.
    pub fn append(&mut self, kind: u8, data: &[u8], sync: bool) -> io::Result<u64> {
        let mut buf = Vec::with_capacity(HEADER as usize + data.len());
        buf.extend_from_slice(&MAGIC);
        buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
        buf.extend_from_slice(&now_ms().to_le_bytes());
        buf.push(kind);
        buf.extend_from_slice(data);
        if let Err(error) = self.file.write_all(&buf) {
            let _ = self.file.set_len(self.len);
            return Err(error);
        }
        // A frame that isn't durable isn't logged: take it back out so the file and `len` agree.
        if sync && let Err(error) = self.file.sync_all() {
            let _ = self.file.set_len(self.len);
            return Err(error);
        }
        self.len += buf.len() as u64;
        self.frames += 1;
        Ok(self.frames - 1)
    }
}

pub struct Reader {
    file: BufReader<File>,
    pub pos: u64,
    pub seq: u64,
}

impl Reader {
    pub fn open(path: &Path, pos: u64, seq: u64) -> io::Result<Reader> {
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(pos))?;
        Ok(Reader {
            file: BufReader::with_capacity(1 << 16, file),
            pos,
            seq,
        })
    }

    /// Next whole frame, or None at the end. An incomplete frame (still being written) is left for
    /// the next call.
    pub fn frame(&mut self) -> io::Result<Option<Frame>> {
        self.next_with(|_| true)
    }

    /// Like `next`, but frames whose kind fails `want` come back with empty data, unread.
    pub fn next_with(&mut self, want: impl Fn(u8) -> bool) -> io::Result<Option<Frame>> {
        let mut header = [0u8; HEADER as usize];
        match self.file.read_exact(&mut header) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return self.rewind(),
            Err(e) => return Err(e),
        }
        let Some((len, ts, kind)) = parse_header(&header) else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("bad frame at {}", self.pos),
            ));
        };
        if !want(kind) {
            let end = self.pos + HEADER + len as u64;
            if end > self.file.get_ref().metadata()?.len() {
                return self.rewind();
            }
            self.file.seek_relative(len as i64)?;
            let frame = Frame {
                seq: self.seq,
                offset: self.pos,
                ts,
                kind,
                data: vec![],
            };
            self.pos = end;
            self.seq += 1;
            return Ok(Some(frame));
        }
        let mut data = vec![0u8; len as usize];
        match self.file.read_exact(&mut data) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return self.rewind(),
            Err(e) => return Err(e),
        }
        let frame = Frame {
            seq: self.seq,
            offset: self.pos,
            ts,
            kind,
            data,
        };
        self.pos += HEADER + len as u64;
        self.seq += 1;
        Ok(Some(frame))
    }

    fn rewind(&mut self) -> io::Result<Option<Frame>> {
        self.file.seek(SeekFrom::Start(self.pos))?;
        Ok(None)
    }

    /// Moves to the first frame boundary at or after `from` whose header and successor both parse.
    /// Used to open the tail of a long log without reading it all. Sequence numbers are unknown
    /// there, so they restart from `u64::MAX / 2` and must not be compared with whole-log ones.
    pub fn sync_to(&mut self, from: u64) -> io::Result<()> {
        let size = self.file.get_ref().metadata()?.len();
        let mut file = self.file.get_ref().try_clone()?;
        let mut window = vec![0u8; 1 << 20];
        let mut start = from;
        while start < size {
            file.seek(SeekFrom::Start(start))?;
            let n = file.read(&mut window)?;
            // Fewer than a magic's worth of bytes left: no boundary can start here.
            if n < MAGIC.len() {
                break;
            }
            for i in 0..n.saturating_sub(3) {
                if window[i..i + 4] == MAGIC && valid_at(&mut file, start + i as u64, size)? {
                    self.file.seek(SeekFrom::Start(start + i as u64))?;
                    self.pos = start + i as u64;
                    self.seq = u64::MAX / 2;
                    return Ok(());
                }
            }
            start += n.saturating_sub(3) as u64;
        }
        self.file.seek(SeekFrom::Start(size))?;
        self.pos = size;
        Ok(())
    }
}

fn valid_at(file: &mut File, at: u64, size: u64) -> io::Result<bool> {
    let mut header = [0u8; HEADER as usize];
    file.seek(SeekFrom::Start(at))?;
    if file.read_exact(&mut header).is_err() {
        return Ok(false);
    }
    let Some((len, _, _)) = parse_header(&header) else {
        return Ok(false);
    };
    let next = at + HEADER + len as u64;
    if next == size {
        return Ok(true);
    }
    if next > size {
        return Ok(false);
    }
    file.seek(SeekFrom::Start(next))?;
    Ok(file.read_exact(&mut header).is_ok() && parse_header(&header).is_some())
}
