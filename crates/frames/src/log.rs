//! Append-only frame log, one per session. A frame is `magic | len u32 | ts_ms u64 | kind u8 | data`
//! in BRG1, with a CRC32 of everything after the magic before `data` in BRG2 (proposed), so a flipped
//! bit is never read silently. A writer keeps its log's format, so hosts of older builds keep working.
//! Only the session's owner writes; anyone may read, and a reader never blocks the writer.

use std::fs::{File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAGIC: [u8; 4] = *b"BRG2";
const OLD_MAGIC: [u8; 4] = *b"BRG1";
const BASE: usize = 17;
const MAX_HEADER: usize = 21;
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

/// Header length for a frame that starts with `magic`, or None for a format this build doesn't know.
fn header_len(magic: &[u8]) -> Option<usize> {
    match magic {
        m if m == OLD_MAGIC => Some(BASE),
        m if m == MAGIC => Some(MAX_HEADER),
        _ => None,
    }
}

struct Head {
    size: u64,
    len: u32,
    ts: u64,
    kind: u8,
    crc: Option<u32>,
}

impl Head {
    fn end(&self, at: u64) -> u64 {
        at + self.size + self.len as u64
    }
}

/// A whole header (`h` holds exactly `header_len` bytes), or None if it can't be one.
fn parse_header(h: &[u8]) -> Option<Head> {
    let size = header_len(h.get(..4)?)?;
    if h.len() != size {
        return None;
    }
    let len = u32::from_le_bytes(h[4..8].try_into().ok()?);
    let ts = u64::from_le_bytes(h[8..16].try_into().ok()?);
    let crc = (size == MAX_HEADER).then(|| u32::from_le_bytes(h[17..21].try_into().unwrap()));
    (len <= MAX_FRAME).then_some(Head {
        size: size as u64,
        len,
        ts,
        kind: h[16],
        crc,
    })
}

fn checksum(h: &[u8], data: &[u8]) -> u32 {
    let mut c = crc32fast::Hasher::new();
    c.update(&h[4..BASE]);
    c.update(data);
    c.finalize()
}

/// Reads one header at the current position: Ok(None) when fewer bytes than a header are left.
fn read_header(r: &mut impl Read, buf: &mut [u8; MAX_HEADER]) -> io::Result<Option<usize>> {
    let eof = |e: io::Error| (e.kind() != io::ErrorKind::UnexpectedEof).then_some(e);
    if let Err(e) = r.read_exact(&mut buf[..BASE]) {
        return eof(e).map_or(Ok(None), Err);
    }
    let size = header_len(&buf[..4]).unwrap_or(BASE);
    if let Err(e) = r.read_exact(&mut buf[BASE..size]) {
        return eof(e).map_or(Ok(None), Err);
    }
    Ok(Some(size))
}

fn damaged(at: u64, what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("{what} at {at}"))
}

pub struct Writer {
    file: File,
    magic: [u8; 4],
    pub len: u64,
    pub frames: u64,
}

impl Writer {
    /// Opens for append, keeping the format the log already has (BRG2 for a new log). Only a torn
    /// last frame (the owner died mid-write) is cut off. Anything else that doesn't parse is refused,
    /// never truncated: an unknown format, or a damaged frame with whole frames after it. Only call
    /// this while holding the session lock.
    pub fn open(path: &Path) -> io::Result<Writer> {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(path)?;
        let size = file.metadata()?.len();
        let mut reader = BufReader::with_capacity(1 << 16, file.try_clone()?);
        let (mut pos, mut frames, mut magic) = (0u64, 0u64, None);
        let mut buf = [0u8; MAX_HEADER];
        while pos < size {
            let Some(n) = read_header(&mut reader, &mut buf)? else {
                break;
            };
            if buf.starts_with(b"BRG") && header_len(&buf[..4]).is_none() {
                return Err(damaged(
                    pos,
                    "frame in a log format this build doesn't know",
                ));
            }
            match parse_header(&buf[..n]) {
                Some(h) if h.end(pos) <= size => {
                    magic.get_or_insert([buf[0], buf[1], buf[2], buf[3]]);
                    reader.seek_relative(h.len as i64)?;
                    pos = h.end(pos);
                    frames += 1;
                }
                _ => break,
            }
        }
        if pos != size {
            // Cut only a real torn tail: if a whole frame follows, this is damage, not a torn write.
            let mut probe = Reader::open(path, pos, 0)?;
            probe.sync_to(pos + 1)?;
            if probe.pos < size {
                return Err(damaged(pos, "damaged frame, not truncating"));
            }
            file.set_len(pos)?;
        }
        Ok(Writer {
            file,
            magic: magic.unwrap_or(MAGIC),
            len: pos,
            frames,
        })
    }

    /// Appends one frame. On a failed write (disk full) the partial frame is cut off again, so the
    /// log never holds a torn frame in the middle. `sync` makes it durable before returning.
    pub fn append(&mut self, kind: u8, data: &[u8], sync: bool) -> io::Result<u64> {
        let size = header_len(&self.magic).unwrap_or(MAX_HEADER);
        let mut buf = Vec::with_capacity(size + data.len());
        buf.extend_from_slice(&self.magic);
        buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
        buf.extend_from_slice(&now_ms().to_le_bytes());
        buf.push(kind);
        if size == MAX_HEADER {
            let crc = checksum(&buf, data);
            buf.extend_from_slice(&crc.to_le_bytes());
        }
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
    /// The file's length when last looked: a skip past it looks again.
    len: u64,
}

impl Reader {
    pub fn open(path: &Path, pos: u64, seq: u64) -> io::Result<Reader> {
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(pos))?;
        Ok(Reader {
            file: BufReader::with_capacity(1 << 16, file),
            pos,
            seq,
            len: 0,
        })
    }

    /// Next whole frame, or None at the end. An incomplete frame (still being written) is left for
    /// the next call.
    pub fn frame(&mut self) -> io::Result<Option<Frame>> {
        self.next_with(|_| true)
    }

    /// Like `next`, but frames whose kind fails `want` come back with empty data, unread (and so
    /// unchecked). A BRG2 frame whose checksum fails is an error, never data.
    pub fn next_with(&mut self, want: impl Fn(u8) -> bool) -> io::Result<Option<Frame>> {
        let mut buf = [0u8; MAX_HEADER];
        let Some(n) = read_header(&mut self.file, &mut buf)? else {
            return self.rewind();
        };
        let Some(head) = parse_header(&buf[..n]) else {
            return Err(damaged(self.pos, "bad frame"));
        };
        let end = head.end(self.pos);
        let mut data = vec![];
        if !want(head.kind) {
            if end > self.len {
                self.len = self.file.get_ref().metadata()?.len();
            }
            if end > self.len {
                return self.rewind();
            }
            self.file.seek_relative(head.len as i64)?;
        } else {
            data = vec![0u8; head.len as usize];
            match self.file.read_exact(&mut data) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return self.rewind(),
                Err(e) => return Err(e),
            }
            if head.crc.is_some_and(|c| c != checksum(&buf, &data)) {
                self.rewind()?;
                return Err(damaged(self.pos, "checksum mismatch"));
            }
        }
        let frame = Frame {
            seq: self.seq,
            offset: self.pos,
            ts: head.ts,
            kind: head.kind,
            data,
        };
        self.pos = end;
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
            if n < 4 {
                break;
            }
            for i in 0..n.saturating_sub(3) {
                if header_len(&window[i..i + 4]).is_some()
                    && valid_at(&mut file, start + i as u64, size)?
                {
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

/// True when a frame starts at `at`: its header parses, a BRG2 checksum matches, and it ends the
/// file or another header follows.
fn valid_at(file: &mut File, at: u64, size: u64) -> io::Result<bool> {
    let mut buf = [0u8; MAX_HEADER];
    file.seek(SeekFrom::Start(at))?;
    let Some(head) = read_header(file, &mut buf)?.and_then(|n| parse_header(&buf[..n])) else {
        return Ok(false);
    };
    let next = head.end(at);
    if next > size {
        return Ok(false);
    }
    if head.crc.is_some() {
        let mut data = vec![0u8; head.len as usize];
        if file.read_exact(&mut data).is_err() {
            return Ok(false);
        }
        if head.crc != Some(checksum(&buf, &data)) {
            return Ok(false);
        }
    }
    if next == size {
        return Ok(true);
    }
    file.seek(SeekFrom::Start(next))?;
    let mut after = [0u8; MAX_HEADER];
    Ok(read_header(file, &mut after)?.is_some_and(|n| parse_header(&after[..n]).is_some()))
}
