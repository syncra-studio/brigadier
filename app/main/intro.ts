// The first launch's intro, from the window's side, as the old app staged it (its electron/main/intro.ts);
// the page plays the rest (ui/src/onboarding/welcome.tsx). On macOS the first launch holds the window
// clear until the page is ready, then stages it: no title-bar buttons, shadow or colour (only the page's
// orb is seen), above a black window that fades in to dim the desktop. When the burst has filled the
// window its chrome comes back; then the dim fades out. Hiding the window, a page load and the deadlines
// all end it, and every end restores the window.
import { BrowserWindow, ipcMain, screen } from "electron";

const HOLD_DEADLINE_MS = 15_000;
const STAGED_DEADLINE_MS = 20_000;
const QUICK_FADE_MS = 300;
const DIM = 0.85;
const DIM_AFTER_MS = 950;
const DIM_IN_MS = 700;

let held: BrowserWindow | null = null;
let staged: BrowserWindow | null = null;
let ends = 0;
let dim: BrowserWindow | null = null;
let fadeTimer: ReturnType<typeof setInterval> | undefined;

/** Eases in and out: the opacity at `progress` of a fade. */
function fadeValue(from: number, to: number, progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  const eased = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
  return from + (to - from) * eased;
}

function fade(window: BrowserWindow, to: number, ms: number, done?: () => void): void {
  clearInterval(fadeTimer);
  const from = window.getOpacity();
  const started = Date.now();
  fadeTimer = setInterval(() => {
    if (window.isDestroyed()) return clearInterval(fadeTimer);
    const progress = ms <= 0 ? 1 : (Date.now() - started) / ms;
    window.setOpacity(fadeValue(from, to, progress));
    if (progress >= 1) {
      clearInterval(fadeTimer);
      done?.();
    }
  }, 16);
}

/** Above the menu bar and the Dock, so the dim covers the whole display with no edge (D120). */
const STAGE_LEVEL = "screen-saver";

/** The window's whole display, square-cornered. */
function dimWindow(window: BrowserWindow): BrowserWindow {
  const made = new BrowserWindow({
    ...screen.getDisplayMatching(window.getBounds()).bounds,
    show: false,
    frame: false,
    roundedCorners: false,
    hasShadow: false,
    focusable: false,
    skipTaskbar: true,
    backgroundColor: colours.dim,
    enableLargerThanScreen: true,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  made.setOpacity(0);
  made.setIgnoreMouseEvents(true);
  made.setAlwaysOnTop(true, STAGE_LEVEL);
  made.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  return made;
}

function shape(window: BrowserWindow, background: string): void {
  window.setHasShadow(true);
  window.setWindowButtonVisibility(true);
  // Unhiding them makes AppKit reset their place to its default; Electron places them before unhiding (D121).
  window.setWindowButtonPosition(window.getWindowButtonPosition());
  window.setBackgroundColor(background);
}

function restore(window: BrowserWindow, background: string, fadeMs: number): void {
  shape(window, background);
  const lower = () => {
    if (window.isDestroyed()) return;
    window.setAlwaysOnTop(false);
    // Another app may have become the active one through a click on the dimmed desktop.
    window.moveTop();
  };
  const going = dim;
  dim = null;
  if (!going || going.isDestroyed()) return lower();
  const close = () => {
    if (!going.isDestroyed()) going.destroy();
    lower();
  };
  if (fadeMs <= 0) close();
  else fade(going, 0, fadeMs, close);
}

let background = "";
let colours = { dim: "", clear: "" };

function end(fadeMs: number, tellPage: boolean): void {
  const going = staged;
  if (!going) return;
  staged = null;
  ends += 1;
  if (going.isDestroyed()) {
    // Its window closed while staged: the dim goes too, or it would stay over the desktop.
    if (dim && !dim.isDestroyed()) dim.destroy();
    dim = null;
    return;
  }
  restore(going, background, fadeMs);
  if (tellPage) going.webContents.send("intro-ended");
}

function unhold(): void {
  const going = held;
  if (!going) return;
  held = null;
  if (going.isDestroyed()) return;
  going.setIgnoreMouseEvents(false);
  going.setOpacity(1);
  going.setBackgroundColor(background);
  going.show();
}

/**
 * Holds `shown` (made transparent, not yet shown) clear for the intro. `colour` is the window's own
 * background, given back when the intro ends; `staging` the desktop's dim and the window's clear.
 */
export function holdForIntro(shown: BrowserWindow, colour: string, staging: typeof colours): void {
  held = shown;
  background = colour;
  colours = staging;
  // A new page has no intro playing, and the intro doesn't outlive its window being seen.
  shown.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) end(0, true);
  });
  shown.on("hide", () => end(0, true));
  shown.on("closed", () => end(0, false));
  // A hidden window's page doesn't paint, and the page waits for a paint: shown, but clear.
  shown.setOpacity(0);
  shown.setIgnoreMouseEvents(true);
  shown.show();
  setTimeout(() => {
    if (held !== shown) return;
    console.warn("The page didn't begin the intro; showing the window");
    unhold();
  }, HOLD_DEADLINE_MS);
}

// The page's intro calls (preload.ts); without a held window they do nothing.
ipcMain.handle("intro-begin", () => {
  const shown = held;
  if (!shown || shown.isDestroyed()) return false;
  held = null;
  staged = shown;
  dim = dimWindow(shown);
  shown.setBackgroundColor(colours.clear);
  shown.setHasShadow(false);
  shown.setWindowButtonVisibility(false);
  shown.setAlwaysOnTop(true, STAGE_LEVEL, 1);
  shown.center();
  dim.showInactive();
  // Brought forward after the dim, so it stands above it on the same level.
  shown.setIgnoreMouseEvents(false);
  shown.setOpacity(1);
  shown.show();
  // Showing brings the title-bar buttons back.
  shown.setWindowButtonVisibility(false);
  const going = dim;
  setTimeout(() => {
    if (dim === going && !going.isDestroyed()) fade(going, DIM, DIM_IN_MS);
  }, DIM_AFTER_MS);
  const armed = ends;
  setTimeout(() => {
    if (ends !== armed || staged !== shown) return;
    console.warn("The intro ran past its deadline; ending it");
    end(QUICK_FADE_MS, true);
  }, STAGED_DEADLINE_MS);
  return true;
});
ipcMain.handle("intro-shaped", () => {
  if (staged && !staged.isDestroyed()) shape(staged, background);
});
ipcMain.handle("intro-finish", (_event, fadeMs: unknown) => end(Math.min(Math.max(Number(fadeMs) || 0, 0), 5000), false));
ipcMain.handle("intro-release", unhold);
