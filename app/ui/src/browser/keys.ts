/**
 * The Browser tab's keys, and its page zoom's steps. A key pressed in a page comes from main (browser/guestKeys.ts)
 * by name and goes on as the press the app's views listen for, as the old app's MENU_KEYS did.
 */

export type BrowserKey =
  | "address"
  | "back"
  | "forward"
  | "reload"
  | "force-reload"
  | "find"
  | "find-next"
  | "find-previous"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset";

type Press = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/**
 * What a key press asks of the browser tab in front, if anything: ⌘L the address, ⌘← and ⌘→
 * back and forward (Alt+← and Alt+→ off macOS), ⌘R reload and ⇧⌘R without the cache, ⌘F find
 * and ⌘G / ⇧⌘G the next and previous match, ⌘= (or ⌘+) / ⌘- / ⌘0 zoom. Ctrl stands for ⌘ off
 * macOS.
 */
export function browserKey(event: Press, mac: boolean): BrowserKey | null {
  const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mac && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (event.code === "ArrowLeft") return "back";
    if (event.code === "ArrowRight") return "forward";
  }
  if (!command || event.altKey) return null;
  const shift = event.shiftKey;
  switch (event.code) {
    case "KeyL":
      return shift ? null : "address";
    case "ArrowLeft":
      return mac && !shift ? "back" : null;
    case "ArrowRight":
      return mac && !shift ? "forward" : null;
    case "KeyR":
      return shift ? "force-reload" : "reload";
    case "KeyF":
      return shift ? null : "find";
    case "KeyG":
      return shift ? "find-previous" : "find-next";
    // ⌘+ is ⌘= with Shift on most keyboards.
    case "Equal":
    case "NumpadAdd":
      return "zoom-in";
    case "Minus":
    case "NumpadSubtract":
      return shift ? null : "zoom-out";
    case "Digit0":
    case "Numpad0":
      return shift ? null : "zoom-reset";
    default:
      return null;
  }
}

/** The page zoom's least and most, 30% and 300%, in its 10% steps. */
export const ZOOM_LEAST = 0.3;
export const ZOOM_MOST = 3;

/** The zoom one 10% step in (`1`) or out (`-1`) from `zoom`, within 30% to 300%. */
export function stepZoom(zoom: number, by: 1 | -1): number {
  const tenths = Math.round(zoom * 10) + by;
  return Math.min(ZOOM_MOST * 10, Math.max(ZOOM_LEAST * 10, tenths)) / 10;
}

/** The zoom as the stepper shows it: "110%". */
export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/**
 * Main's names for the keys a page gave up, as the presses the app's views listen for (⌘ and the key). ⌘W, ⌘[ and ⌘]
 * are the menu's, sent on as its commands (preload.ts); the old app's New browser, Side chat and New page aren't built.
 */
const GUEST_KEYS: Record<string, { code: string; shift?: boolean; control?: boolean; alt?: boolean }> = {
  new: { code: "KeyT" },
  reopen: { code: "KeyT", shift: true },
  address: { code: "KeyL" },
  "close-others": { code: "KeyW", alt: true },
  previous: { code: "BracketLeft", shift: true },
  next: { code: "BracketRight", shift: true },
  "previous-tab": { code: "ArrowLeft", alt: true },
  "next-tab": { code: "ArrowRight", alt: true },
  "cycle-next": { code: "Tab", control: true },
  "cycle-previous": { code: "Tab", control: true, shift: true },
  "terminal-alternate": { code: "Backquote", control: true },
  ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`tab-${index + 1}`, { code: `Digit${index + 1}` }])),
  ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`profile-${index + 1}`, { code: `Digit${index + 1}`, alt: true }])),
  reload: { code: "KeyR" },
  "force-reload": { code: "KeyR", shift: true },
  find: { code: "KeyF" },
  "find-next": { code: "KeyG" },
  "find-previous": { code: "KeyG", shift: true },
  "zoom-in": { code: "Equal" },
  "zoom-out": { code: "Minus" },
  "zoom-reset": { code: "Digit0" },
};

/** What `key` (`a`, `[`, `0`) types, for a view that reads `event.key`. */
const KEY_OF: Record<string, string> = { BracketLeft: "[", BracketRight: "]", Equal: "=", Minus: "-", Backquote: "`", Tab: "Tab", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight" };

/** Presses `name` in the app, where the keyboard is now. */
export function pressGuestKey(name: string): void {
  const key = GUEST_KEYS[name];
  if (!key) return;
  const typed = KEY_OF[key.code] ?? key.code.replace(/^(Key|Digit)/, "").toLowerCase();
  (document.activeElement ?? window).dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: key.code,
      key: typed,
      metaKey: !key.control,
      ctrlKey: key.control ?? false,
      shiftKey: key.shift ?? false,
      altKey: key.alt ?? false,
    }),
  );
}
