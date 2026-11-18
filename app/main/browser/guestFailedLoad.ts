// A page that couldn't load. Chromium has already put an empty error document at the failed address, so the
// address bar, Back and Reload stay right; this fills that document in. Nothing retries by itself: the
// load runs again only when the user presses Try again.
import { readFileSync } from "node:fs";
import path from "node:path";

import type { WebContents } from "electron";

import { isLocalHost, trustLocalCert } from "./localCerts";
import { profileOfStorage } from "./profiles";

/** The headline and the sentence for Chromium's net error codes that a person can act on. */
function words(code: number, host: string, local: boolean): { title: string; body: string } {
  const site = host || "This site";
  if (local) return { title: "This local site's certificate isn't trusted", body: "Open it anyway? Brigadier won't ask again for this site in this profile." };
  if (code === -105 || code === -137) return { title: "Can't find this site", body: `No server was found for ${site}. Check the address for a typo.` };
  if (code === -102) return { title: "This site refused to connect", body: `${site} isn't accepting connections right now. It may be down, or on another port.` };
  if (code === -106) return { title: "You're offline", body: "This Mac isn't connected to the internet." };
  if (code === -7 || code === -118) return { title: "This site took too long to answer", body: `${site} didn't respond in time.` };
  if (code === -100 || code === -101 || code === -21) return { title: "The connection was lost", body: `The connection to ${site} ended before the page arrived.` };
  if (code === -109 || code === -104) return { title: "Can't reach this site", body: `The way to ${site} couldn't be found from this network.` };
  if (code <= -200 && code > -300) return { title: "This connection isn't secure", body: `${site} couldn't prove who it is, so the page wasn't opened.` };
  return { title: "This page couldn't open", body: `Something went wrong while loading ${site}.` };
}

// The app's surfaces and control, copied from its theme (as main.ts reads it): a guest can't read the app's stylesheet.
const theme = readFileSync(path.join(__dirname, "../../../ui/src/theme.css"), "utf8");
const TOKENS = ["color-background", "color-foreground", "color-muted-foreground", "color-primary", "color-primary-fg", "color-primary-hover", "color-ring", "radius-control"];
const STYLE = `
  :root { ${TOKENS.map((name) => `--${name}: ${new RegExp(`--${name}:\\s*([^;]+);`).exec(theme)![1]};`).join(" ")} }
  html, body { height: 100%; margin: 0; }
  body { display: flex; align-items: center; justify-content: center; background: var(--color-background); color: var(--color-foreground); color-scheme: dark;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
  main { width: min(26rem, calc(100% - 3rem)); }
  h1 { margin: 0 0 .5rem; font-size: 18px; font-weight: 600; letter-spacing: -.01em; }
  p { margin: 0; color: var(--color-muted-foreground); overflow-wrap: anywhere; }
  code { display: block; margin-top: .75rem; color: var(--color-muted-foreground); font: 11px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; overflow-wrap: anywhere; }
  button { margin-top: 1.25rem; height: 2rem; padding: 0 .75rem; border: 0; border-radius: var(--radius-control); background: var(--color-primary); color: var(--color-primary-fg); font: inherit; font-weight: 500; cursor: default; }
  button:hover { background: var(--color-primary-hover); }
  button:focus-visible { outline: 2px solid var(--color-ring); outline-offset: 2px; }
`;

/** Runs in the error document. Everything from outside goes in as text, never as markup. */
function fill(url: string, code: number, description: string, local: boolean): string {
  let host = "";
  try {
    host = new URL(url).host;
  } catch { /* the words manage without */ }
  const { title, body } = words(code, host, local);
  return `(() => {
    const text = ${JSON.stringify({ url, title, body, host, local, detail: description || `Error ${code}`, css: STYLE })};
    document.title = text.host || text.title;
    const sheet = document.createElement("style");
    sheet.textContent = text.css;
    document.head.append(sheet);
    const main = document.createElement("main");
    main.dataset.failedLoad = text.detail;
    const part = (tag, words) => { const made = document.createElement(tag); made.textContent = words; main.append(made); return made; };
    part("h1", text.title);
    part("p", text.body);
    part("code", text.url + " · " + text.detail);
    const again = part("button", text.local ? "Open anyway" : "Try again");
    again.id = text.local ? "open-anyway" : "try-again";
    if (!text.local) again.addEventListener("click", () => location.reload());
    document.body.replaceChildren(main);
  })()`;
}

const OPEN_ANYWAY = `new Promise((resolve) => document.getElementById("open-anyway").addEventListener("click", () => resolve(true)))`;

export function installFailedLoad(contents: WebContents): void {
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 is an aborted load: a newer navigation or Stop. A scheme that isn't the web's has the tab's own banner.
    if (!isMainFrame || code === -3 || !/^https?:/.test(url)) return;
    // A certificate error (-2xx) on this computer's dev host may be opened anyway; anywhere else it stays refused.
    const profileId = profileOfStorage(contents.session.storagePath ?? null);
    const hostname = URL.parse(url)?.hostname ?? "";
    const local = code <= -200 && code > -300 && profileId !== null && isLocalHost(hostname);
    contents.executeJavaScript(fill(url, code, description, local)).then(async () => {
      if (!local || !profileId) return;
      // Leaving the page ends the wait, which is no error.
      const open: unknown = await contents.executeJavaScript(OPEN_ANYWAY).catch(() => false);
      if (open !== true || contents.isDestroyed()) return;
      trustLocalCert(profileId, hostname);
      contents.reload();
    }, (error: unknown) => {
      console.warn("Could not show a page's failed load:", url, code, error);
    });
  });
}
