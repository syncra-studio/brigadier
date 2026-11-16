// What a page's new windows become. A <webview> can't adopt a window that already has an opener, so there are
// two kinds: window.open with features (a sign-in popup, say) is a real window that keeps window.opener and
// postMessage, and anything else (target=_blank, window.open with no features) is a tab of the opener, with none.
import { BrowserWindow, type HandlerDetails, type WebContents } from "electron";

import { watchSiteActivity } from "./browserClearData";
import { installGuestLogins } from "./browserLogins";
import { watchSignIn } from "./browserSignIn";
import { installFailedLoad } from "./guestFailedLoad";
import { installGuestLinks, takeOsLink } from "./guestLinks";
import { installGuestMenu } from "./guestMenu";

/** Which tab's guest a popup came from, however many popups deep: a tab it opens goes beside that one. */
const tabGuest = new WeakMap<WebContents, WebContents>();

export const webOrBlank = (url: string) => /^https?:/.test(url) || url === "about:blank" || url === "";

/** The features ask for a window, and the page didn't give up its opener. */
function keepsOpener({ disposition, features }: HandlerDetails): boolean {
  if (disposition !== "new-window" || !features.trim()) return false;
  return !features.split(/[\s,]+/).some((feature) => /^(noopener|noreferrer)(=|$)/i.test(feature));
}

export function openAsTab(from: WebContents, url: string): void {
  const guest = tabGuest.get(from) ?? from;
  if (guest.isDestroyed() || !webOrBlank(url)) {
    console.warn("A page's new tab dropped:", url);
    return;
  }
  guest.hostWebContents?.send("brigadier:guest-popup", { from: guest.id, url });
}

/** Everything a page gets, in a tab's guest or in a popup. */
export function installGuest(contents: WebContents): void {
  installGuestMenu(contents, openAsTab);
  watchSiteActivity(contents);
  installGuestLogins(contents);
  // shortcut: no passkey notice until that section lands (guestPasskey's refusal); the passkey preload already fails a request at once.
  installFailedLoad(contents);
  watchSignIn(contents, tabGuest.get(contents) ?? contents);
  installGuestLinks(contents);
  contents.setWindowOpenHandler((details) => {
    if (takeOsLink(contents, details.url)) return { action: "deny" };
    if (!keepsOpener(details) || !webOrBlank(details.url)) {
      openAsTab(contents, details.url);
      return { action: "deny" };
    }
    const host = (tabGuest.get(contents) ?? contents).hostWebContents;
    const parent = host ? BrowserWindow.fromWebContents(host) : null;
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        ...(parent ? { parent } : {}),
        fullscreenable: false,
        // The opener's session comes by itself, so the popup is signed in as its tab is.
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false },
      },
    };
  });
  contents.on("did-create-window", (window) => adopt(window, contents));
}

function adopt(window: BrowserWindow, opener: WebContents): void {
  const page = window.webContents;
  tabGuest.set(page, tabGuest.get(opener) ?? opener);
  installGuest(page);
  // A popup has no address bar: its title always says whose page this is, which a sign-in needs.
  const title = (text: string) => {
    let site = "";
    try {
      site = new URL(page.getURL()).host;
    } catch { /* not loaded yet */ }
    window.setTitle(site && text && text !== site ? `${site} — ${text}` : site || text);
  };
  page.on("page-title-updated", (event, text) => {
    event.preventDefault();
    title(text);
  });
  page.on("did-navigate", () => title(page.getTitle()));
}
