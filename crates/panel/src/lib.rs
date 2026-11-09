//! Loaded once into the app's main process with `process.dlopen`, it readies macOS's folder picker
//! without showing anything [D389]: `[NSOpenPanel openPanel]` loads the frameworks the first panel of
//! a run needs. Electron has no call for that. A failure leaves the picker as it was, only slower.

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{c_char, c_void};

    type Id = *mut c_void;

    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {}

    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Id;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(pool: *mut c_void);
    }

    /// Node's entry point for an addon, run on the main thread AppKit needs.
    ///
    /// # Safety
    /// Only Node calls this, on the main thread, as it loads the addon.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn napi_register_module_v1(_env: Id, exports: Id) -> Id {
        unsafe {
            let send: unsafe extern "C" fn(Id, Id) -> Id =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let pool = objc_autoreleasePoolPush();
            send(
                objc_getClass(c"NSOpenPanel".as_ptr()),
                sel_registerName(c"openPanel".as_ptr()),
            );
            objc_autoreleasePoolPop(pool);
        }
        exports
    }
}
