// The browser's pages: one fixed layer of <webview> for the whole life of the app's window. It's the
// first child of <body>, a sibling of #root, so nothing React mounts or keys can touch it: switching
// sessions, New Tab becoming a page and closing a panel only change where a page shows.
//
// A page is hidden with visibility:hidden and is never moved or removed until its tab closes, since
// Electron destroys a <webview>'s page when its element leaves the DOM (the same finding as Orca's
// and others'; no code comes from them). The layer lies under #root: the app cuts a hole in itself where
// a page shows (hole.ts), so its own menus and floating controls draw over the live page in one compositor.
// Where a page shows is in data attributes, which the theme reads (theme.css's #brigadier-tab-layer).

import { readFavicon } from "./favicon";
import { pressGuestKey, ZOOM_LEAST, ZOOM_MOST } from "./keys";
import { watchUserComposition } from "./focus-guard";
import { agentShields, dropOverlay, installAgentOverlays, placeOverlay } from "./overlay";
import { devToolsChanged, userUsed } from "./pause";
import { type SignInSeen, signInSeen } from "./sign-in";
import { recordDates, trustLocalCert } from "./profiles";

declare global {
  interface Window {
    /** The browser's door (main's preload.ts). */
    brigadierShell: {
      profilePartition(profileId: string): Promise<string>;
      guestFavicon(id: number, href: string): Promise<string | null>;
      onGuestPopup(listener: (details: { from: number; url: string }) => void): void;
      onGuestPermission(listener: (details: { from: number; request: number; origin: string; camera: boolean; microphone: boolean; location: boolean }) => void): void;
      onGuestPermissionRefused(listener: (details: { from: number; origin: string; refused: string[] }) => void): void;
      onGuestEscape(listener: (details: { from: number }) => void): void;
      onGuestKey(listener: () => void): void;
      /** A swipe over a tab's page so far, and at its end (main's browser/guestSwipe.ts) [D3110]. */
      onPageSwipe(listener: (details: { from: number; dx: number; events: number; end: boolean }) => void): () => void;
      onGuestShortcut(listener: (key: string) => void): void;
      answerPermission(request: number, answer: "once" | "visiting" | "never" | "dismiss"): Promise<void>;
      openPermissionSettings(device: "camera" | "microphone" | "location"): Promise<void>;
      /** DevTools' panes and the element picker (main's browser/browserDevtools.ts), by the guest's id. */
      devtools(op: string, args: { guest: number } & Record<string, unknown>): Promise<unknown>;
      /** A profile's Chromium data (main's browser/profileStore.ts): remove, counts, clear. */
      profiles(op: string, args: { profile: string } & Record<string, unknown>): Promise<unknown>;
      /** Import's engine half (main's browser/browserImport.ts): icon, opened, clear, cookies, settled, access. */
      browserImport(op: string, args: Record<string, unknown>): Promise<unknown>;
      onBrowserDates(listener: (details: { profile: string; cookies: unknown[]; sites: unknown[] }) => void): void;
      /** A local dev site's untrusted certificate opened anyway (main's browser/localCerts.ts), for Rust to keep. */
      onLocalCert(listener: (details: { profile: string; host: string }) => void): void;
      onAgentEvent(listener: (details: { from: number; event: "devtools-opened" | "devtools-closed" | "detached" }) => void): void;
      /** An agent's verbs on a guest (main's browser/browserAgent.ts). */
      agent(call: Record<string, unknown>): Promise<unknown>;
      /** What a tab's page, or a window it opened, shows that only the user goes through (main's browser/browserSignIn.ts). */
      onGuestSignIn(listener: (details: { from: number } & SignInSeen) => void): void;
    };
  }
}

/** Where a page shows, in the window's CSS pixels. */
export type BrowserBounds = { x: number; y: number; width: number; height: number };
export type BrowserFound = { found: boolean; current: number; total: number };
/** What a tab's page tells its tab. */
export type BrowserEvent =
  | { type: "load"; url: string; loading: boolean }
  | { type: "history"; canGoBack: boolean; canGoForward: boolean }
  | { type: "title"; title: string }
  | { type: "favicon"; url: string; dataUrl: string }
  | { type: "blocked"; url: string }
  | { type: "failed"; url: string }
  | { type: "escape" }
  | { type: "popup"; id: string; url: string }
  | { type: "closed" }
  | { type: "permissionRefused"; origin: string; refused: string[] }
  | { type: "permission"; request: number; origin: string; camera: boolean; microphone: boolean; location: boolean };

/** Electron's <webview> element, as far as the layer uses it. */
export type Webview = HTMLElement & {
  src: string;
  getWebContentsId(): number;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  isLoading(): boolean;
  setZoomFactor(factor: number): void;
  getZoomFactor(): number;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean }): number;
  stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
  print(): Promise<void>;
  executeJavaScript(code: string): Promise<unknown>;
};

type Page = {
  id: string;
  element: Webview;
  profileId: string;
  emit: (event: BrowserEvent) => void;
  ready: boolean;
  /** Set while a find is on its way; `found-in-page` answers it. */
  finding: ((found: BrowserFound) => void) | null;
  shown: boolean;
  /** The element's own methods throw until its first dom-ready, so this follows the events. */
  url: string;
  loading: boolean;
  /** The page loads so far: an agent's refs and the user's yes hold within one. */
  generation: number;
};

const pages = new Map<string, Page>();
let layer: HTMLDivElement | null = null;

/**
 * A page holding the keyboard keeps it through a host element's focus(): Chromium moves it back only when a frame
 * of the host says it took focus (WebContentsImpl::SetFocusedFrame), a frame says so only when Blink's focused frame
 * changes, and the app's page may already be that frame. hostWebContents.focus() does nothing here on macOS, since
 * the host's view is first responder all along (RenderWidgetHostViewMac::Focus), and window.focus() asks for a user
 * gesture that a key taken in the page never gave the host. So a hidden frame takes focus, then the app's page does.
 */
let keyboardFrame: HTMLIFrameElement | null = null;
let keyboardAnchor: HTMLElement | null = null;
/** A page's shortcut just came through it, whatever document.hasFocus() says. */
let pageHadKey = false;
/** The tab whose page gets the keyboard once it shows: its page may not exist or show yet. */
let wantsKeyboard: string | null = null;
const nativeFocus = HTMLElement.prototype.focus;

function keyboardInPage(): boolean {
  return pageHadKey || !document.hasFocus();
}

function takeKeyboard(): void {
  if (!keyboardFrame || !keyboardAnchor) return;
  pageHadKey = false;
  const had = document.activeElement;
  nativeFocus.call(keyboardFrame, { preventScroll: true });
  nativeFocus.call(keyboardAnchor, { preventScroll: true });
  if (had instanceof HTMLElement && had !== document.body && had !== keyboardFrame && had !== keyboardAnchor && had.tagName !== "WEBVIEW") {
    nativeFocus.call(had, { preventScroll: true });
  } else {
    keyboardAnchor.blur();
  }
}

function focusTakingKeyboard(this: HTMLElement, options?: FocusOptions): void {
  if (this.tagName !== "WEBVIEW" && keyboardInPage()) takeKeyboard();
  nativeFocus.call(this, options);
}

function installKeyboardHandover(): void {
  keyboardAnchor = document.createElement("div");
  keyboardAnchor.id = "brigadier-keyboard-anchor";
  keyboardAnchor.tabIndex = -1;
  keyboardAnchor.setAttribute("aria-hidden", "true");
  keyboardFrame = document.createElement("iframe");
  keyboardFrame.tabIndex = -1;
  keyboardAnchor.append(keyboardFrame);
  document.body.append(keyboardAnchor);
  // Every field of the app, by whatever path it takes focus: autoFocus, a menu key, a shortcut.
  HTMLElement.prototype.focus = focusTakingKeyboard;
  window.brigadierShell.onGuestKey(() => { pageHadKey = true; });
}

/** The page whose guest is `from`, once it has one. */
const pageOf = (from: number) => [...pages.values()].find((page) => page.ready && page.element.getWebContentsId() === from);
/** The tab's page whose guest is `from`, for walking its history; none under an agent's shield, whose passed-on wheels
 * the page tallies as a swipe of its own [D3110]. */
export const guestPage = (from: number): Webview | undefined => {
  const page = pageOf(from);
  return page && !agentShields(page.id) ? page.element : undefined;
};

export function installTabLayer(): void {
  layer = document.createElement("div");
  layer.id = "brigadier-tab-layer";
  document.body.prepend(layer);

  installKeyboardHandover();
  installAgentOverlays();
  watchUserComposition();

  // A drag anywhere in the app must not fall into a page it crosses: the divider's or a text
  // selection's pointer stays with the app until it's let go.
  window.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Element && event.target.closest("webview, .brigadier-agent-frame")) return;
    pageHadKey = false;
    layer?.toggleAttribute("data-locked", true);
  }, { capture: true });
  const release = () => { if (!modal) layer?.toggleAttribute("data-locked", false); };
  window.addEventListener("pointerup", release, { capture: true });
  window.addEventListener("pointercancel", release, { capture: true });
  window.addEventListener("blur", release);

  window.brigadierShell.onGuestPopup(({ from, url }) => pageOf(from)?.emit({ type: "popup", id: crypto.randomUUID(), url }));
  window.brigadierShell.onGuestPermission(({ from, ...question }) => pageOf(from)?.emit({ type: "permission", ...question }));
  window.brigadierShell.onGuestPermissionRefused(({ from, origin, refused }) => pageOf(from)?.emit({ type: "permissionRefused", origin, refused }));
  window.brigadierShell.onGuestEscape(({ from }) => pageOf(from)?.emit({ type: "escape" }));
  window.brigadierShell.onGuestShortcut(pressGuestKey);
  window.brigadierShell.onBrowserDates(recordDates);
  window.brigadierShell.onLocalCert(trustLocalCert);
  // shortcut: no passkey notice until that section lands (guestPasskey's refusal); the passkey preload already fails a request at once.
  window.brigadierShell.onGuestSignIn(({ from, ...seen }) => {
    const page = pageOf(from);
    if (page) signInSeen(page.id, seen);
  });
  window.brigadierShell.onAgentEvent(({ from, event }) => {
    const page = pageOf(from);
    if (!page) return;
    // Nothing resumes by itself: DevTools closing, or a debugger ended from outside, leaves the tab with the user.
    if (event === "detached") userUsed(page.id);
    else devToolsChanged(page.id, event === "devtools-opened");
  });
}

/** The tab's page's guest, for main's calls on it. */
export const guestOf = (id: string): number => need(id).element.getWebContentsId();

function need(id: string): Page {
  const page = pages.get(id);
  if (!page) throw new Error(`No page for tab ${id}`);
  return page;
}

function place(page: Page, bounds: BrowserBounds | null): void {
  const { element } = page;
  placeOverlay(page.id, bounds);
  if (bounds === null) {
    element.removeAttribute("data-shown");
    if (wantsKeyboard === page.id) wantsKeyboard = null;
    // A hidden page must not hold the keyboard: typing would go to it unseen.
    if (page.shown && keyboardInPage()) takeKeyboard();
    page.shown = false;
    return;
  }
  element.dataset.left = String(bounds.x);
  element.dataset.top = String(bounds.y);
  element.dataset.width = String(bounds.width);
  element.dataset.height = String(bounds.height);
  element.toggleAttribute("data-shown", true);
  page.shown = true;
  if (wantsKeyboard === page.id && element.isConnected) {
    wantsKeyboard = null;
    // Unless the person went on to a field of the app while the page was coming.
    if (document.activeElement === null || document.activeElement === document.body) element.focus();
  }
}

const NOT_FOUND: BrowserFound = { found: false, current: 0, total: 0 };

function answerFind(page: Page, found: BrowserFound): void {
  page.finding?.(found);
  page.finding = null;
}

function listen(page: Page): void {
  const { element } = page;
  const emit = (event: BrowserEvent) => page.emit(event);
  const on = <T>(name: string, listener: (event: T) => void) =>
    element.addEventListener(name, listener as unknown as EventListener);
  const history = () => emit({
    type: "history",
    canGoBack: page.ready && element.canGoBack(),
    canGoForward: page.ready && element.canGoForward(),
  });
  const loadChanged = () => { emit({ type: "load", url: page.url, loading: page.loading }); history(); };
  // A load drops a find in flight, with no answer from the old document: the bar looks again when it stops.
  on("did-start-loading", () => { answerFind(page, NOT_FOUND); page.loading = true; loadChanged(); });
  on("did-stop-loading", () => { page.loading = false; loadChanged(); });
  on<{ url: string }>("did-navigate", ({ url }) => { page.url = url; page.generation += 1; loadChanged(); });
  on<{ url: string; isMainFrame: boolean }>("did-navigate-in-page", ({ url, isMainFrame }) => {
    // A frame's own navigation adds to the tab's history too.
    if (!isMainFrame) { history(); return; }
    page.url = url;
    loadChanged();
  });
  on<{ title: string }>("page-title-updated", ({ title }) => emit({ type: "title", title }));
  const favicon = () => {
    const url = page.url;
    void readFavicon((code) => element.executeJavaScript(code), (href) => window.brigadierShell.guestFavicon(element.getWebContentsId(), href)).then((dataUrl) => {
      if (dataUrl) emit({ type: "favicon", url, dataUrl });
    });
  };
  // Each document, whatever Chromium says: it sent nothing for the second page of a site with the same icon.
  on("dom-ready", favicon);
  // And a page that changes its icon later.
  on("page-favicon-updated", favicon);
  // A web page that can't load gets its own page (main's browser/guestFailedLoad.ts); any other scheme can't open here.
  on<{ errorCode: number; validatedURL: string; isMainFrame: boolean }>("did-fail-load", ({ errorCode, validatedURL, isMainFrame }) => {
    // -3 is an aborted load, which a newer navigation or the Stop button causes.
    if (isMainFrame && errorCode !== -3) emit({ type: /^https?:/.test(validatedURL) ? "failed" : "blocked", url: validatedURL });
  });
  on("close", () => emit({ type: "closed" }));
  on<{ result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean } }>("found-in-page", ({ result }) => {
    if (result.finalUpdate) answerFind(page, { found: result.matches > 0, current: result.activeMatchOrdinal, total: result.matches });
  });
}

/** Opens in flight: React's strict effects ask twice, and there must be one page per tab. */
const opening = new Map<string, Promise<void>>();

/** Makes the tab's page at `url`, hidden at `bounds` until placed; a tab that has one loads `url` in it. */
export function openPage(id: string, url: string, profileId: string, bounds: BrowserBounds, emit: (event: BrowserEvent) => void): Promise<void> {
  const inFlight = opening.get(id);
  if (inFlight) return inFlight;
  const existing = pages.get(id);
  if (existing) {
    existing.emit = emit;
    load(existing, url);
    return Promise.resolve();
  }
  const open = makePage(id, url, profileId, bounds, emit).finally(() => opening.delete(id));
  opening.set(id, open);
  return open;
}

async function makePage(id: string, url: string, profileId: string, bounds: BrowserBounds, emit: (event: BrowserEvent) => void): Promise<void> {
  const element = document.createElement("webview") as Webview;
  element.setAttribute("partition", await window.brigadierShell.profilePartition(profileId));
  element.setAttribute("allowpopups", "");
  element.dataset.tab = id;
  const page: Page = { id, element, profileId, emit, ready: false, finding: null, shown: false, url, loading: true, generation: 0 };
  pages.set(id, page);
  listen(page);
  place(page, bounds);
  element.removeAttribute("data-shown");
  page.shown = false;
  await new Promise<void>((resolve) => {
    element.addEventListener("dom-ready", () => { page.ready = true; resolve(); }, { once: true });
    // Main destroys a guest with any other first address, and dom-ready would never come (a tab restored at a blob:).
    element.setAttribute("src", /^https?:/.test(url) ? url : "about:blank");
    (layer as HTMLDivElement).append(element);
  });
}

/**
 * Starts a load and leaves its outcome to the page's events: did-fail-load tells a real failure from an abort.
 * loadURL's promise also rejects when Stop or a newer address cuts the load short, which is no error.
 */
function load(page: Page, url: string): void {
  page.element.loadURL(url).catch(() => {});
}

/** Loads `url` in the tab's page where it is, showing nothing new. */
export function loadPage(id: string, url: string): void {
  load(need(id), url);
}

/** The tab's guest, for an agent's call; the element's methods work only from its first dom-ready. */
export function agentPage(id: string): { guest: number; element: Webview; generation: number } {
  const page = need(id);
  if (!page.ready) throw new Error(`The page of tab ${id} isn't ready yet.`);
  return { guest: page.element.getWebContentsId(), element: page.element, generation: page.generation };
}

/**
 * Runs `take` with the tab's page painting. A page behind its tab has no surface for capturePage (UnknownVizError). The
 * layer lies under the app, which covers it where it cuts no hole, so the page can show for this long with nothing seen.
 */
export async function whilePainting<T>(id: string, take: () => Promise<T>): Promise<T> {
  const { element, shown } = need(id);
  if (shown) return take();
  element.toggleAttribute("data-painting", true);
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return await take();
  } finally {
    element.removeAttribute("data-painting");
  }
}

/** Where the tab's page shows now; null behind its tab. */
export function pageBounds(id: string): BrowserBounds | null {
  const { element, shown } = need(id);
  if (!shown) return null;
  const { left, top, width, height } = element.dataset;
  return { x: Number(left), y: Number(top), width: Number(width), height: Number(height) };
}

export function navigatePage(id: string, url: string, bounds: BrowserBounds): void {
  const page = need(id);
  place(page, page.shown ? bounds : null);
  load(page, url);
}

/** Shows the tab's page at `bounds`, or hides it (null). */
export function placePage(id: string, bounds: BrowserBounds | null): void {
  const page = pages.get(id);
  if (page) place(page, bounds);
}

let modal = false;
/** A menu or dialog of the app is open: a click on a page must reach the app, which closes it. */
export function setModal(open: boolean): void {
  modal = open;
  layer?.toggleAttribute("data-locked", open);
}

export function go(id: string, action: string): void {
  const { element } = need(id);
  switch (action) {
    case "back":
    case "back-unless-typing":
      element.goBack();
      break;
    case "forward":
    case "forward-unless-typing":
      element.goForward();
      break;
    case "reload":
      element.reload();
      break;
    case "force-reload":
      element.reloadIgnoringCache();
      break;
    case "stop":
      element.stop();
      break;
    default:
      throw new Error(`Unknown action ${action}`);
  }
}

/** Sets the page's zoom (null leaves it) and says what it is. */
export function zoom(id: string, factor: number | null): number {
  const { element } = need(id);
  if (factor !== null) element.setZoomFactor(Math.min(ZOOM_MOST, Math.max(ZOOM_LEAST, factor)));
  return element.getZoomFactor();
}

/** The keyboard to the tab's page, or back to the app's own (null). */
export function focusPage(id: string | null): void {
  wantsKeyboard = null;
  if (id === null) {
    if (keyboardInPage()) takeKeyboard();
    return;
  }
  const page = pages.get(id);
  // A hidden element can't take focus, and a first address has no page yet: place() gives it when it shows.
  if (page?.element.isConnected && page.element.hasAttribute("data-shown")) page.element.focus();
  else wantsKeyboard = id;
}

export function find(id: string, query: string, step: "type" | "next" | "previous"): Promise<BrowserFound> {
  const page = need(id);
  if (!query) {
    answerFind(page, NOT_FOUND);
    page.element.stopFindInPage("clearSelection");
    return Promise.resolve(NOT_FOUND);
  }
  return new Promise((resolve) => {
    // Chromium answers only the latest of two quick searches; the earlier one mustn't wait for ever.
    answerFind(page, NOT_FOUND);
    page.finding = resolve;
    page.element.findInPage(query, { forward: step !== "previous", findNext: step === "type" });
  });
}

export function printPage(id: string): Promise<void> {
  return need(id).element.print();
}

export function closePage(id: string): void {
  const page = pages.get(id);
  if (!page) return;
  answerFind(page, NOT_FOUND);
  pages.delete(id);
  dropOverlay(id);
  page.element.remove();
}
