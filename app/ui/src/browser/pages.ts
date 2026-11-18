import { useSyncExternalStore } from "react";

import { newId } from "../session/store";
import { closeTab, driveTab, openTab, setTabProfile, tabsOf } from "../shell/tab-store";
import { stepZoom } from "./keys";
import { closeFind, findState, forgetFind } from "./find";
import { type BrowserBounds, closePage as closeInLayer, focusPage, navigatePage, openPage as openInLayer, zoom } from "./layer";
import { saveCardAnswer, siteAsked } from "./data";
import { defaultOf, known, pinTab } from "./profiles";

/**
 * The Browser tabs' pages as the app knows them, one per tab: what each shows, heard from its
 * <webview> in the layer (layer.ts). The page itself lives there, under the tab.
 */

export type BrowserPage = {
  url: string;
  title: string;
  loading: boolean;
  ready?: boolean;
  favicon?: string | null;
  /** The last navigation the tab refused, offered to the system browser. */
  blocked: string | null;
  /** A web page that didn't load, till the next load starts: the Mockup tab's frames show their own failed state. */
  failed?: string | null;
  /** What the page's history allows, once the page has said. */
  canGoBack?: boolean;
  canGoForward?: boolean;
  /** The page zoom (1 is 100%) the page last said; it stays from page to page in the tab. */
  zoom?: number;
  /** The page's question for the camera, microphone or location, waiting for an answer. */
  asking?: BrowserAsking | null;
  /** What the system refused or has off, after the person allowed it here. */
  osRefused?: { origin: string; refused: OsRefused[] } | null;
};

export type BrowserAsking = { request: number; origin: string; camera: boolean; microphone: boolean; location?: boolean };
export type OsRefused = "camera" | "microphone" | "location";
export type PermissionAnswer = "once" | "visiting" | "never" | "dismiss";

const pages = new Map<string, BrowserPage>();
/** The tabs whose page the layer has made, so it is told where to go, not made again. */
const made = new Set<string>();
/** Whose tabs each is in, for what its page opens or closes (Home's move to the session its first message makes). */
const owners = new Map<string, string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useBrowserPage = (id: string): BrowserPage | undefined => useSyncExternalStore(subscribe, () => pages.get(id));
export const browserPage = (id: string): BrowserPage | undefined => pages.get(id);

/** Bumped on every change, so a reader of all the pages draws again. */
let version = 0;
/** Every tab's page, by tab. */
export function useBrowserPages(): ReadonlyMap<string, BrowserPage> {
  useSyncExternalStore(subscribe, () => version);
  return pages;
}

function set(id: string, page: BrowserPage | undefined): void {
  if (page) pages.set(id, page);
  else pages.delete(id);
  version++;
  for (const listener of listeners) listener();
}

function update(id: string, patch: Partial<BrowserPage>): void {
  const page = pages.get(id);
  if (page) set(id, { ...page, ...patch });
}

/**
 * Whether a favicon sent from `url` belongs to the tab's `page`: the same document, also after a
 * hash change, or a same-origin `pushState` once the page has loaded. While a new page loads, the
 * previous one's late favicons are refused; another origin's always are.
 */
export function faviconFits(page: Pick<BrowserPage, "url" | "loading"> | undefined, url: string): boolean {
  if (!page) return false;
  if (url === page.url) return true;
  try {
    const sent = new URL(url);
    const shown = new URL(page.url);
    if (sent.origin !== shown.origin) return false;
    sent.hash = shown.hash = "";
    return sent.href === shown.href || !page.loading;
  } catch {
    return false;
  }
}

/** A page's site, `scheme://host[:port]`; null for none. */
export function originOf(url: string): string | null {
  try {
    const { protocol, host } = new URL(url);
    return host ? `${protocol}//${host}` : null;
  } catch {
    return null;
  }
}

/** Opens `url` in the Browser tab `id` of `owner`'s tabs, over `bounds`. */
export async function openPage(owner: string, id: string, url: string, bounds: BrowserBounds): Promise<void> {
  owners.set(id, owner);
  const page = pages.get(id);
  set(id, {
    url,
    title: page?.title ?? "",
    loading: true,
    blocked: null,
    ready: made.has(id),
    ...(page?.canGoBack === undefined ? {} : { canGoBack: page.canGoBack }),
    ...(page?.canGoForward === undefined ? {} : { canGoForward: page.canGoForward }),
    ...(page?.zoom === undefined ? {} : { zoom: page.zoom }),
  });
  try {
    if (made.has(id)) {
      navigatePage(id, url, bounds);
      return;
    }
    await openInLayer(id, url, await pinTab(owner, id), bounds, (event) => {
      if (event.type === "load") {
        const shown = pages.get(id);
        if (!event.loading) syncZoom(id);
        update(id, {
          url: event.url,
          loading: event.loading,
          ...(event.loading ? { failed: null } : {}),
          // Another site's. A pushState looks like any other load here and nothing sends its icon again;
          // a new page of this site keeps the old icon until its own arrives, as in a browser.
          ...(originOf(event.url) !== originOf(shown?.url ?? "") ? { favicon: null } : {}),
          // Main drops a question from a site the page left.
          ...(shown?.asking && originOf(event.url) !== shown.asking.origin ? { asking: null } : {}),
        });
      } else if (event.type === "history") update(id, { canGoBack: event.canGoBack, canGoForward: event.canGoForward });
      else if (event.type === "title") update(id, { title: event.title });
      else if (event.type === "favicon") {
        if (faviconFits(pages.get(id), event.url)) update(id, { favicon: event.dataUrl });
      } else if (event.type === "escape") {
        if (findState(id).open) closeFind(id);
      } else if (event.type === "popup") {
        // A page's new tab opens beside its own, as the old app's did, signed in as its opener; an agent's opens behind, still its.
        const at = owners.get(id);
        const from = at ? tabsOf(at).tabs.find((tab) => tab.id === id) : undefined;
        if (at) {
          const popup = from?.driver ? `t-${newId()}` : openTab(at, "browser", event.url);
          if (from?.driver) driveTab(at, popup, event.url, from.driver);
          if (from?.profile) setTabProfile(at, popup, from.profile);
        }
      } else if (event.type === "closed") {
        const at = owners.get(id);
        if (at) closeTab(at, id);
      } else if (event.type === "permission") {
        const { request, origin, camera, microphone, location } = event;
        update(id, { asking: { request, origin, camera, microphone, ...(location ? { location } : {}) } });
        void siteAsked(profileOf(owner, id), origin, camera ? "camera" : microphone ? "microphone" : "location");
      } else if (event.type === "permissionRefused") update(id, { osRefused: { origin: event.origin, refused: event.refused as OsRefused[] } });
      else if (event.type === "blocked") update(id, { blocked: event.url, loading: false });
      else if (event.type === "failed") update(id, { failed: event.url });
    });
    // Closed while it was coming.
    if (!pages.get(id)) {
      closeInLayer(id);
      return;
    }
    made.add(id);
    update(id, { ready: true });
    if (focusOnOpen.delete(id)) focusPage(id);
  } catch (error) {
    update(id, { loading: false });
    throw error;
  }
}

/** The profile tab `id`'s page is on, which pinTab gave it when the page was made. */
const profileOf = (owner: string, id: string) => known(tabsOf(owner).tabs.find((tab) => tab.id === id)?.profile) ?? defaultOf().id;

/** The tab answers its page's question, which goes. */
export function answerPermission(id: string, answer: PermissionAnswer): void {
  const asking = pages.get(id)?.asking;
  if (!asking) return;
  update(id, { asking: null });
  const owner = owners.get(id);
  if (owner) void saveCardAnswer(profileOf(owner, id), asking.origin, asking, answer);
  window.brigadierShell.answerPermission(asking.request, answer).catch((error: unknown) => console.error("answering the page failed", error));
}

export function closeOsRefused(id: string): void {
  update(id, { osRefused: null });
}

/** Zooms the tab's page to `to` (1 is 100%), keeping what the page says it came to. */
export function zoomPage(id: string, to: number): void {
  update(id, { zoom: zoom(id, to) });
}

/** Reads the zoom the page is at: it belongs to the site, so a load or another tab can change it. */
export function syncZoom(id: string): void {
  if (made.has(id)) update(id, { zoom: zoom(id, null) });
}

export const zoomStep = (id: string, by: 1 | -1) => zoomPage(id, stepZoom(pages.get(id)?.zoom ?? 1, by));

/** A load starts now (the page says so too, a moment later). */
export const loadStarts = (id: string) => update(id, { loading: true });

export function dismissBlocked(id: string): void {
  update(id, { blocked: null });
}

/** Whether tab `id` has its page in the layer to act on. */
export const pageReady = (id: string): boolean => made.has(id);

const focusOnOpen = new Set<string>();
/** The page goes and its tab makes it again where it shows, on the tab's profile now; `focus`: the keyboard goes back to it. */
export function reopenPage(id: string, focus: boolean): void {
  if (focus) focusOnOpen.add(id);
  closeBrowserPage(id);
}

/** The tab closed: the page goes. */
export function closeBrowserPage(id: string): void {
  forgetFind(id);
  owners.delete(id);
  if (!pages.get(id)) return;
  made.delete(id);
  set(id, undefined);
  closeInLayer(id);
}
