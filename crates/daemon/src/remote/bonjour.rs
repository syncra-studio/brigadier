//! The Mac on Bonjour as `_brigadier._tcp`, registered with macOS's own DNS-SD (libSystem's
//! `dns_sd.h`), only while the gateway runs. Dropping the registration takes the Mac off. Its TXT
//! carries `v` (the pairing version), `pk` (the Mac's Noise key, base64url) and `o=1` while an
//! offer is open, so a phone with only the typed code finds the Mac (remote design §4 "Typed code").

use std::ffi::{c_char, c_void};
use std::io;
use std::ptr;

unsafe extern "C" {
    fn DNSServiceRegister(
        sd_ref: *mut *mut c_void,
        flags: u32,
        interface: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        host: *const c_char,
        port: u16,
        txt_len: u16,
        txt: *const c_void,
        callback: *const c_void,
        context: *mut c_void,
    ) -> i32;
    fn DNSServiceUpdateRecord(
        sd_ref: *mut c_void,
        record: *mut c_void,
        flags: u32,
        len: u16,
        data: *const c_void,
        ttl: u32,
    ) -> i32;
    fn DNSServiceRefDeallocate(sd_ref: *mut c_void);
}

pub(super) struct Registration(*mut c_void);

// Only ever deallocated, once, by its owner.
unsafe impl Send for Registration {}

/// The TXT record: each entry its length byte, then `key=value`.
pub(super) fn txt(public: &[u8], open: bool) -> Vec<u8> {
    use base64::Engine;
    let pk = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(public);
    let mut out = vec![];
    for entry in [
        "v=1".to_string(),
        format!("pk={pk}"),
        format!("o={}", u8::from(open)),
    ] {
        out.push(entry.len() as u8);
        out.extend(entry.as_bytes());
    }
    out
}

/// Announces `port` under the Mac's own name, on every interface.
pub(super) fn register(port: u16, txt: &[u8]) -> io::Result<Registration> {
    let mut sd = ptr::null_mut();
    let err = unsafe {
        DNSServiceRegister(
            &mut sd,
            0,
            0,
            ptr::null(),
            c"_brigadier._tcp".as_ptr(),
            ptr::null(),
            ptr::null(),
            port.to_be(),
            txt.len() as u16,
            txt.as_ptr().cast(),
            ptr::null(),
            ptr::null_mut(),
        )
    };
    match err {
        0 => Ok(Registration(sd)),
        e => Err(io::Error::other(format!(
            "Bonjour registration failed ({e})"
        ))),
    }
}

impl Registration {
    /// Replaces the TXT record (a null record names the registration's own).
    pub(super) fn update(&self, txt: &[u8]) {
        let len = txt.len() as u16;
        unsafe { DNSServiceUpdateRecord(self.0, ptr::null_mut(), 0, len, txt.as_ptr().cast(), 0) };
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        unsafe { DNSServiceRefDeallocate(self.0) };
    }
}
