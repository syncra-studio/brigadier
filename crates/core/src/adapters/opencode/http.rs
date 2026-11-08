//! The little HTTP/1.1 its server needs: one request at a time, and its event stream.

use serde_json::Value;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

pub struct Server {
    pub addr: String,
    pub auth: String,
}

impl Server {
    fn connect(&self, method: &str, path: &str, body: &Value) -> io::Result<TcpStream> {
        let mut stream = TcpStream::connect(&self.addr)?;
        // The event stream beats every 15 s; silence for a minute is a dead connection.
        stream.set_read_timeout(Some(Duration::from_secs(60)))?;
        let body = if body.is_null() {
            String::new()
        } else {
            body.to_string()
        };
        let auth = &self.auth;
        let head = format!(
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nAuthorization: Basic {auth}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            self.addr,
            body.len()
        );
        stream.write_all((head + &body).as_bytes())?;
        Ok(stream)
    }

    /// One request: its status and body.
    pub fn request(&self, method: &str, path: &str, body: &Value) -> io::Result<(u16, String)> {
        let mut r = BufReader::new(self.connect(method, path, body)?);
        let (status, chunked) = head(&mut r)?;
        let mut out = Vec::new();
        match chunked {
            true => {
                while let Some(chunk) = next_chunk(&mut r)? {
                    out.extend(chunk);
                }
            }
            false => drop(r.read_to_end(&mut out)?),
        }
        Ok((status, String::from_utf8_lossy(&out).into_owned()))
    }

    /// Reads the event stream until it ends, handing each event to `on`.
    pub fn events(&self, mut on: impl FnMut(Value)) -> io::Result<()> {
        let mut r = BufReader::new(self.connect("GET", "/api/event", &Value::Null)?);
        let (status, chunked) = head(&mut r)?;
        if status != 200 {
            return Err(io::Error::other(format!("event stream: {status}")));
        }
        let mut buf = Vec::new();
        loop {
            let more = match chunked {
                true => next_chunk(&mut r)?,
                false => Some(r.fill_buf().map(|b| b.to_vec())?).filter(|b| !b.is_empty()),
            };
            let Some(more) = more else {
                return Ok(());
            };
            if !chunked {
                r.consume(more.len());
            }
            buf.extend(more);
            while let Some(at) = buf.windows(2).position(|w| w == b"\n\n") {
                let block: Vec<u8> = buf.drain(..at + 2).collect();
                for line in String::from_utf8_lossy(&block).lines() {
                    if let Some(v) = line
                        .strip_prefix("data: ")
                        .and_then(|d| serde_json::from_str(d).ok())
                    {
                        on(v);
                    }
                }
            }
        }
    }
}

/// A response's status, and whether its body is chunked.
fn head(r: &mut impl BufRead) -> io::Result<(u16, bool)> {
    let mut line = String::new();
    r.read_line(&mut line)?;
    let status = line
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let mut chunked = false;
    loop {
        line.clear();
        if r.read_line(&mut line)? == 0 || line == "\r\n" {
            return Ok((status, chunked));
        }
        chunked |= line
            .to_ascii_lowercase()
            .starts_with("transfer-encoding: chunked");
    }
}

/// The next chunk of a chunked body; None at its end.
fn next_chunk(r: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut size = String::new();
    if r.read_line(&mut size)? == 0 {
        return Ok(None);
    }
    let n = usize::from_str_radix(size.trim().split(';').next().unwrap_or(""), 16)
        .map_err(|_| io::Error::other("bad chunk"))?;
    let mut chunk = vec![0; n + 2];
    r.read_exact(&mut chunk)?;
    chunk.truncate(n);
    Ok((n > 0).then_some(chunk))
}
