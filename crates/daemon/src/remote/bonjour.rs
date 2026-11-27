//! The Mac on Bonjour as `_brigadier._tcp`, registered with macOS's own DNS-SD (libSystem's
//! `dns_sd.h`), only while the gateway runs. Dropping the registration takes the Mac off.

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
    fn DNSServiceRefDeallocate(sd_ref: *mut c_void);
}

pub(super) struct Registration(*mut c_void);

// Only ever deallocated, once, by its owner.
unsafe impl Send for Registration {}

/// Announces `port` under the Mac's own name, on every interface.
pub(super) fn register(port: u16) -> io::Result<Registration> {
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
            0,
            ptr::null(),
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

impl Drop for Registration {
    fn drop(&mut self) {
        unsafe { DNSServiceRefDeallocate(self.0) };
    }
}
