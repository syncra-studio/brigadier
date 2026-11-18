// Clear browsing data's engine part, for one profile: cookies, site storage and the cache. Chromium gives
// neither cookies nor site storage a date Electron can
// read (`Cookie` has no creation time, `clearData` no range), so Rust keeps them (crates/cli/src/browser/dates.rs):
// main sends when each cookie last changed and when each origin last had a frame. One last seen before this ran counts as older.
import fs from "node:fs";
import path from "node:path";
import { app, session, webContents, type Session, type WebContents } from "electron";

import { toAppPages } from "./appPage";
import { forgetLocalCerts } from "./localCerts";
import { profileFolderName, profileOfStorage, profilePartition } from "./profiles";

const STORAGE_KINDS = ["backgroundFetch", "fileSystems", "indexedDB", "localStorage", "serviceWorkers", "webSQL"] as const;

type CookieKey = { domain: string; path: string; name: string };
/** `dated`: what Rust has changed since `sinceMs`; null clears everything. */
export type EngineClear = { sinceMs: number | null; cookies: boolean; cache: boolean; dated: { cookies: CookieKey[]; origins: string[] } | null };

type Seen = { cookies: Map<string, CookieKey & { lastMs: number | null }>; sites: Map<string, number> };
/** What waits for the next send, by profile: a site can set dozens of cookies at once, and this is the main thread. */
const waiting = new Map<string, Seen>();
let sendSoon: ReturnType<typeof setTimeout> | null = null;

function seenBy(profileId: string): Seen {
  let seen = waiting.get(profileId);
  if (!seen) waiting.set(profileId, (seen = { cookies: new Map(), sites: new Map() }));
  sendSoon ??= setTimeout(send, 1000);
  return seen;
}

/** To the page, which gives it to Rust. */
function send(): void {
  sendSoon = null;
  for (const [profile, { cookies, sites }] of waiting) {
    toAppPages("brigadier:browser-dates", {
      profile,
      cookies: [...cookies.values()],
      sites: [...sites].map(([origin, lastMs]) => ({ origin, lastMs })),
    });
  }
  waiting.clear();
}

/** Dates a profile's cookies from the moment its session opens. */
export function watchProfileCookies(created: Session): void {
  const profileId = profileOfStorage(created.storagePath ?? null);
  if (!profileId) return;
  created.cookies.on("changed", (_event, cookie, cause, removed) => {
    // An overwrite comes as a removal and a set: the set says when it changed.
    if (removed && cause === "overwrite") return;
    const domain = cookie.domain ?? "";
    const path = cookie.path ?? "";
    seenBy(profileId).cookies.set(`${domain}|${path}|${cookie.name}`, { domain, path, name: cookie.name, lastMs: removed ? null : Date.now() });
  });
}

const originOf = (url: string): string | null => {
  try {
    const { protocol, origin } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? origin : null;
  } catch {
    return null;
  }
};

/** Dates each origin a guest's frames go to, for clearing site data by range. */
export function watchSiteActivity(contents: WebContents): void {
  const profileId = profileOfStorage(contents.session.storagePath ?? null);
  if (!profileId) return;
  contents.on("did-frame-navigate", (_event, url) => {
    const origin = originOf(url);
    if (origin) seenBy(profileId).sites.set(origin, Date.now());
  });
}

/** Origins with data that may have changed since `sinceMs`: Rust's, those still waiting to go, and those with a frame now. */
function originsSince(profileId: string, profileSession: Session, sinceMs: number, dated: string[]): string[] {
  const origins = new Set(dated);
  for (const [origin, lastMs] of waiting.get(profileId)?.sites ?? []) if (lastMs >= sinceMs) origins.add(origin);
  for (const contents of webContents.getAllWebContents()) {
    if (contents.session !== profileSession) continue;
    for (const frame of contents.mainFrame.framesInSubtree) {
      const origin = originOf(frame.url);
      if (origin) origins.add(origin);
    }
  }
  return [...origins];
}

async function clearCookiesAndSiteData(profileId: string, profileSession: Session, { sinceMs, dated }: EngineClear): Promise<void> {
  if (sinceMs === null || dated === null) {
    await profileSession.clearData({ dataTypes: ["cookies", ...STORAGE_KINDS] });
    await profileSession.clearAuthCache();
    // An import into an open profile waits there for the next start, which would sign it back in.
    fs.rmSync(path.join(app.getPath("userData"), "browser-import-staged", profileFolderName(profileId)), { recursive: true, force: true });
  } else {
    const changed = new Set(dated.cookies.map(({ domain, path, name }) => `${domain}|${path}|${name}`));
    for (const [key, { lastMs }] of waiting.get(profileId)?.cookies ?? []) if (lastMs !== null && lastMs >= sinceMs) changed.add(key);
    for (const cookie of await profileSession.cookies.get({})) {
      if (!changed.has(`${cookie.domain ?? ""}|${cookie.path ?? ""}|${cookie.name}`)) continue;
      const host = (cookie.domain ?? "").replace(/^\./, "");
      await profileSession.cookies.remove(`${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`, cookie.name);
    }
    const origins = originsSince(profileId, profileSession, sinceMs, dated.origins);
    if (origins.length > 0) await profileSession.clearData({ dataTypes: [...STORAGE_KINDS], origins });
  }
  // Written out now: a crash right after a clear mustn't bring a sign-in back.
  await profileSession.cookies.flushStore();
  profileSession.flushStorageData();
}

export async function clearEngineData(profileId: string, clear: EngineClear): Promise<void> {
  const profileSession = session.fromPartition(profilePartition(profileId));
  if (clear.cookies) await clearCookiesAndSiteData(profileId, profileSession, clear);
  if (clear.cookies) forgetLocalCerts(profileId, profileSession);
  // Chromium's cache has no range Electron offers: any range clears all of it, as the form says.
  if (clear.cache) await profileSession.clearData({ dataTypes: ["cache"] });
}
