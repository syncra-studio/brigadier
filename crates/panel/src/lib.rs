//! Loaded once into the app's main process with `process.dlopen`, it readies macOS's folder picker
//! without showing anything [D389]: `[NSOpenPanel openPanel]` loads the frameworks the first panel of
//! a run needs. Electron has no call for that. A failure leaves the picker as it was, only slower.
//! It also answers `notifications()`: what macOS lets Brigadier's notices do, which only the app's
//! own process can ask and Electron can't [D611]. And it watches the app's scroll-wheel events
//! for swiping Back and Forward [D3110]: whether a scroll is a trackpad's (a mouse's wheel is never a
//! swipe) and when the fingers lift, before any momentum; Electron tells neither.

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{c_char, c_ulong, c_void};
    use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
    use std::time::{Duration, Instant};

    type Id = *mut c_void;

    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {}

    #[link(name = "UserNotifications", kind = "framework")]
    unsafe extern "C" {}

    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Id;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(pool: *mut c_void);
    }

    unsafe extern "C" {
        static _NSConcreteStackBlock: c_void;
    }

    // Node's own, found in the app's process when it loads the addon (build.rs).
    unsafe extern "C" {
        fn napi_create_function(
            env: Id,
            name: *const c_char,
            length: usize,
            cb: unsafe extern "C" fn(Id, Id) -> Id,
            data: Id,
            result: *mut Id,
        ) -> i32;
        fn napi_create_string_utf8(
            env: Id,
            text: *const c_char,
            length: usize,
            result: *mut Id,
        ) -> i32;
        fn napi_get_null(env: Id, result: *mut Id) -> i32;
        fn napi_get_boolean(env: Id, value: bool, result: *mut Id) -> i32;
        fn napi_create_uint32(env: Id, value: u32, result: *mut Id) -> i32;
        fn napi_set_named_property(env: Id, object: Id, name: *const c_char, value: Id) -> i32;
    }

    unsafe fn send(to: Id, name: &std::ffi::CStr) -> Id {
        unsafe {
            let send: unsafe extern "C" fn(Id, Id) -> Id =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            send(to, sel_registerName(name.as_ptr()))
        }
    }

    unsafe fn number(to: Id, name: &std::ffi::CStr) -> isize {
        unsafe {
            let send: unsafe extern "C" fn(Id, Id) -> isize =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            send(to, sel_registerName(name.as_ptr()))
        }
    }

    /// Node's entry point for an addon, run on the main thread AppKit needs.
    ///
    /// # Safety
    /// Only Node calls this, on the main thread, as it loads the addon.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn napi_register_module_v1(env: Id, exports: Id) -> Id {
        unsafe {
            let pool = objc_autoreleasePoolPush();
            send(objc_getClass(c"NSOpenPanel".as_ptr()), c"openPanel");
            watch_scrolls();
            objc_autoreleasePoolPop(pool);
            let calls: [(&std::ffi::CStr, unsafe extern "C" fn(Id, Id) -> Id); 3] = [
                (c"notifications", notifications),
                (c"trackpadScroll", trackpad_scroll),
                (c"scrollLifts", scroll_lifts),
            ];
            for (name, call) in calls {
                let mut function = std::ptr::null_mut();
                if napi_create_function(
                    env,
                    name.as_ptr(),
                    usize::MAX,
                    call,
                    std::ptr::null_mut(),
                    &mut function,
                ) == 0
                {
                    napi_set_named_property(env, exports, name.as_ptr(), function);
                }
            }
        }
        exports
    }

    // The last scroll-wheel event's: precise deltas are a trackpad's (or a Magic Mouse's surface),
    // never a wheel's; and how many times fingers have left the trackpad.
    static PRECISE: AtomicBool = AtomicBool::new(true);
    static LIFTS: AtomicU32 = AtomicU32::new(0);

    #[repr(C)]
    struct MonitorBlock {
        isa: *const c_void,
        flags: i32,
        reserved: i32,
        invoke: unsafe extern "C" fn(*mut MonitorBlock, Id) -> Id,
        descriptor: *const Descriptor,
    }

    static MONITOR_DESCRIPTOR: SyncDescriptor = SyncDescriptor(Descriptor {
        reserved: 0,
        size: size_of::<MonitorBlock>() as c_ulong,
        signature: c"@16@?0@8".as_ptr(),
    });

    /// Each scroll-wheel event of the app's windows, seen before Chromium gets it, and passed on as it was.
    unsafe extern "C" fn scrolled(_block: *mut MonitorBlock, event: Id) -> Id {
        unsafe {
            let flag: unsafe extern "C" fn(Id, Id) -> bool =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            PRECISE.store(
                flag(
                    event,
                    sel_registerName(c"hasPreciseScrollingDeltas".as_ptr()),
                ),
                Ordering::Relaxed,
            );
            // NSEventPhaseEnded 8 or Cancelled 16 with no momentum phase: the fingers lifted.
            if number(event, c"phase") & (8 | 16) != 0 && number(event, c"momentumPhase") == 0 {
                LIFTS.fetch_add(1, Ordering::Relaxed);
            }
        }
        event
    }

    /// `[NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel handler:]`, kept for the run.
    unsafe fn watch_scrolls() {
        unsafe {
            let mut block = MonitorBlock {
                isa: &raw const _NSConcreteStackBlock,
                flags: 1 << 30, // BLOCK_HAS_SIGNATURE; AppKit copies it, and it holds nothing
                reserved: 0,
                invoke: scrolled,
                descriptor: &MONITOR_DESCRIPTOR.0,
            };
            let add: unsafe extern "C" fn(Id, Id, u64, *mut MonitorBlock) -> Id =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let monitor = add(
                objc_getClass(c"NSEvent".as_ptr()),
                sel_registerName(c"addLocalMonitorForEventsMatchingMask:handler:".as_ptr()),
                1 << 22, // NSEventTypeScrollWheel
                &mut block,
            );
            if !monitor.is_null() {
                send(monitor, c"retain");
            }
        }
    }

    /// `trackpadScroll()`: whether the last scroll-wheel event was a trackpad's; true before any.
    unsafe extern "C" fn trackpad_scroll(env: Id, _info: Id) -> Id {
        let mut value = std::ptr::null_mut();
        unsafe { napi_get_boolean(env, PRECISE.load(Ordering::Relaxed), &mut value) };
        value
    }

    /// `scrollLifts()`: how many times fingers have left the trackpad this run; a change is a lift.
    unsafe extern "C" fn scroll_lifts(env: Id, _info: Id) -> Id {
        let mut value = std::ptr::null_mut();
        unsafe { napi_create_uint32(env, LIFTS.load(Ordering::Relaxed), &mut value) };
        value
    }

    // What getNotificationSettings answered, as the page's words; -1 until it has.
    const STATES: [&std::ffi::CStr; 4] = [c"unasked", c"blocked", c"hidden", c"sent"];

    #[repr(C)]
    struct Descriptor {
        reserved: c_ulong,
        size: c_ulong,
        signature: *const c_char,
    }

    // A block holding only where to put the answer, so copying it needs no helpers.
    #[repr(C)]
    struct Block {
        isa: *const c_void,
        flags: i32,
        reserved: i32,
        invoke: unsafe extern "C" fn(*mut Block, Id),
        descriptor: *const Descriptor,
        answer: *const AtomicI32,
    }

    struct SyncDescriptor(Descriptor);
    unsafe impl Sync for SyncDescriptor {}
    static DESCRIPTOR: SyncDescriptor = SyncDescriptor(Descriptor {
        reserved: 0,
        size: size_of::<Block>() as c_ulong,
        signature: c"v16@?0@8".as_ptr(),
    });

    /// UNNotificationSettings in: not asked yet, off, allowed but on neither the desktop nor in
    /// Notification Center (a lock screen alone isn't seen while working), or on.
    unsafe extern "C" fn answered(block: *mut Block, settings: Id) {
        unsafe {
            let state = match number(settings, c"authorizationStatus") {
                0 => 0,
                1 => 1,
                // UNNotificationSettingEnabled is 2.
                _ if number(settings, c"alertSetting") != 2
                    && number(settings, c"notificationCenterSetting") != 2 =>
                {
                    2
                }
                _ => 3,
            };
            (*(*block).answer).store(state, Ordering::Release);
        }
    }

    /// `notifications()`: "unasked", "blocked", "hidden" or "sent" (on); null outside an .app or when macOS doesn't answer.
    unsafe extern "C" fn notifications(env: Id, _info: Id) -> Id {
        unsafe {
            let state = ask();
            let mut value = std::ptr::null_mut();
            match state {
                Some(state) => {
                    napi_create_string_utf8(env, STATES[state].as_ptr(), usize::MAX, &mut value)
                }
                None => napi_get_null(env, &mut value),
            };
            value
        }
    }

    unsafe fn ask() -> Option<usize> {
        unsafe {
            let pool = objc_autoreleasePoolPush();
            let url = send(
                send(objc_getClass(c"NSBundle".as_ptr()), c"mainBundle"),
                c"bundleURL",
            );
            let extension = send(url, c"pathExtension");
            let wanted: unsafe extern "C" fn(Id, Id, *const c_char) -> Id =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let equal: unsafe extern "C" fn(Id, Id, Id) -> bool =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let dot_app = wanted(
                objc_getClass(c"NSString".as_ptr()),
                sel_registerName(c"stringWithUTF8String:".as_ptr()),
                c"app".as_ptr(),
            );
            // Only an .app has a notification center; asking elsewhere throws.
            let bundled = equal(
                extension,
                sel_registerName(c"isEqualToString:".as_ptr()),
                dot_app,
            );
            objc_autoreleasePoolPop(pool);
            if !bundled {
                return None;
            }
            let answer = Box::new(AtomicI32::new(-1));
            let mut block = Block {
                isa: &raw const _NSConcreteStackBlock,
                flags: 1 << 30, // BLOCK_HAS_SIGNATURE
                reserved: 0,
                invoke: answered,
                descriptor: &DESCRIPTOR.0,
                answer: &*answer,
            };
            let center = send(
                objc_getClass(c"UNUserNotificationCenter".as_ptr()),
                c"currentNotificationCenter",
            );
            let get: unsafe extern "C" fn(Id, Id, *mut Block) =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            get(
                center,
                sel_registerName(c"getNotificationSettingsWithCompletionHandler:".as_ptr()),
                &mut block,
            );
            // It answers on a queue of its own in a few milliseconds.
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(2) {
                let state = answer.load(Ordering::Acquire);
                if state >= 0 {
                    return Some(state as usize);
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            // macOS may still answer after the wait gives up, and must find it there.
            Box::leak(answer);
            None
        }
    }
}
