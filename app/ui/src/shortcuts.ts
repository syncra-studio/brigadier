import catalog from "./shortcuts.json";

/*
 * Every keyboard shortcut, in one list (shortcuts.json) that Settings › Keyboard shortcuts shows, the handlers match
 * with `matches` and main's menu takes its accelerators from, so none can drift [D2013]. Keys are Electron
 * accelerators ("CmdOrCtrl+Shift+E"), with a range of digits as "1–9" and two presses as "Esc Esc".
 */

export type Shortcut = { id: string; keys: readonly string[]; name: string; line: string; where?: string };

export const SHORTCUTS: readonly Shortcut[] = catalog;

const MAC = window.brigadier ? window.brigadier.platform === "darwin" : /Mac/.test(navigator.platform);

// A key's glyph, where it isn't written by its name.
const ARROWS: Record<string, string> = { Up: "↑", Down: "↓", Left: "←", Right: "→" };
const MAC_KEYS: Record<string, string> = { ...ARROWS, Enter: "⏎", Backspace: "⌫" };

type Stroke = { ctrl: boolean; alt: boolean; shift: boolean; cmd: boolean; key: string };

/** One press as this platform writes it: "⇧⌘A" on macOS, "Ctrl+Shift+A" elsewhere. */
function write({ ctrl, alt, shift, cmd, key }: Stroke): string {
  if (MAC) return `${ctrl ? "⌃" : ""}${alt ? "⌥" : ""}${shift ? "⇧" : ""}${cmd ? "⌘" : ""}${MAC_KEYS[key] ?? key}`;
  return [ctrl || cmd ? "Ctrl" : "", alt ? "Alt" : "", shift ? "Shift" : "", ARROWS[key] ?? key].filter(Boolean).join("+");
}

function parse(accelerator: string): Stroke {
  const parts = accelerator.split("+");
  const key = parts.pop()!;
  return { ctrl: parts.includes("Ctrl"), alt: parts.includes("Alt"), shift: parts.includes("Shift"), cmd: parts.includes("CmdOrCtrl"), key };
}

// Each shortcut's chips, written for this platform once.
const WRITTEN = new Map(SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.keys.map((chip) => chip.split(" ").map((press) => write(parse(press))).join(" "))]));

/** A shortcut's keys as this platform writes them, one per chip ("⌥⌘B" on macOS, "Ctrl+Alt+B" elsewhere). */
export const keysOf = (id: string): string[] => WRITTEN.get(id)!;

const CODES: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Escape: "Esc",
  Backspace: "Backspace",
  Delete: "Backspace",
  Tab: "Tab",
  Space: "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};
const MODIFIERS = ["Control", "Alt", "Shift", "Meta", "CapsLock", "Fn", "AltGraph"];

/**
 * A press as this platform writes it, by the key's place (`code`) so ⌥ and layouts don't change it; null for a
 * modifier alone, or the Windows key, which no shortcut uses. A symbol typed plainly ("@") is the symbol.
 */
export function strokeOf(event: KeyboardEvent): string | null {
  if (MODIFIERS.includes(event.key) || (!MAC && event.metaKey)) return null;
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
  const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
  if (plain && !letter && !CODES[event.code] && event.key.length === 1 && !/^\d$/.test(event.key)) return event.key;
  const key = letter ?? /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1] ?? CODES[event.code] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return write({ ctrl: MAC && event.ctrlKey, alt: event.altKey, shift: event.shiftKey, cmd: MAC ? event.metaKey : event.ctrlKey, key });
}

/** Whether `press` (as `strokeOf` writes it) is one of a shortcut's keys; "1–9" takes any of those digits. */
export function firesOn(id: string, press: string): boolean {
  const digit = /[1-9]$/.exec(press)?.[0];
  return keysOf(id).some((chip) => chip.split(" ").some((each) => each === press || (digit !== undefined && each.replace("1–9", digit) === press)));
}

// While Settings › Keyboard shortcuts records a press, or the guided tour points [D3109], no shortcut fires.
let recording = false;
let held = false;

/** Holds every shortcut, the app menu's keys too, while `on`. */
export function holdShortcuts(on: boolean): void {
  held = on;
  window.brigadier?.ignoreMenuKeys(on);
}

/** Whether a key press is the shortcut `id`, exactly: no modifier more or less. */
export function matches(event: KeyboardEvent, id: string): boolean {
  if (recording || held || event.isComposing) return false;
  const press = strokeOf(event);
  return press !== null && firesOn(id, press);
}

/**
 * Records one press, for Settings › Keyboard shortcuts' search by keystrokes: until it comes no shortcut fires, and
 * the page never sees the key. `onPress` gets it, or null for Esc, which cancels. Returns a function that stops.
 */
export function recordKeyPress(onPress: (press: string | null) => void): () => void {
  let on = true;
  recording = true;
  window.brigadier?.ignoreMenuKeys(true);
  const swallow = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const stop = () => {
    if (!on) return;
    on = recording = false;
    window.brigadier?.ignoreMenuKeys(false);
    removeEventListener("keydown", onKeyDown, true);
    removeEventListener("keyup", swallow, true);
  };
  function onKeyDown(event: KeyboardEvent) {
    swallow(event);
    const press = event.isComposing ? null : strokeOf(event);
    if (press === null) return;
    stop();
    onPress(press === "Esc" ? null : press);
  }
  addEventListener("keydown", onKeyDown, true);
  addEventListener("keyup", swallow, true);
  return stop;
}
