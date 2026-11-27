//! Whether the Mac runs on mains power, read from IOKit for the phone's Keep this Mac awake
//! (remote design §4.6). Read each pass, so no `pmset` runs every tick. A Mac with no battery
//! reports mains power.

use std::ffi::{CStr, c_char, c_void};

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOPSCopyPowerSourcesInfo() -> *const c_void;
    fn IOPSGetProvidingPowerSourceType(blob: *const c_void) -> *const c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringGetCString(s: *const c_void, buf: *mut c_char, size: isize, encoding: u32) -> u8;
    fn CFRelease(cf: *const c_void);
}

const UTF8: u32 = 0x0800_0100;

pub(super) fn plugged_in() -> bool {
    let mut buf = [0 as c_char; 32];
    // The blob is ours to release; the type string belongs to it (the Get rule).
    let read = unsafe {
        let blob = IOPSCopyPowerSourcesInfo();
        if blob.is_null() {
            return false;
        }
        let kind = IOPSGetProvidingPowerSourceType(blob);
        let read = !kind.is_null() && CFStringGetCString(kind, buf.as_mut_ptr(), 32, UTF8) != 0;
        CFRelease(blob);
        read
    };
    read && unsafe { CStr::from_ptr(buf.as_ptr()) }.to_bytes() == b"AC Power"
}
