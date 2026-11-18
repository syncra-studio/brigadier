// Settings › Import Browser Data, main's half: Rust (crates/cli/src/browser/imports.rs) reads the other browser's
// sign-ins and copies its site storage; main sets the cookies in the profile's session, which only it can reach, and
// puts staged site storage in place before any session opens [D725].
import path from "node:path";

import { app, type CookiesSetDetails, nativeImage, session, shell, webContents } from "electron";

import { handleFromApp } from "./appPage";
import { applyStagedStorage } from "./browserImportStaged";
import { profileOfStorage, profilePartition } from "./profiles";

/** A cookie as Rust read it (crates/browser-data). */
type ReadCookie = {
  name: string;
  value: string;
  domain: string;
  host_only: boolean;
  path: string;
  expires_unix: number | null;
  secure: boolean;
  http_only: boolean;
  same_site: "None" | "Lax" | "Strict" | null;
  source_insecure: boolean;
};

/** The longest Chromium lets a cookie live, and what a session cookie gets. */
const SESSION_COOKIE_SECONDS = 400 * 24 * 60 * 60;
const SAME_SITE = { None: "no_restriction", Lax: "lax", Strict: "strict" } as const;

/** The arguments that set a read cookie again, in the shape it had: host-only stays host-only. */
function cookieDetails(cookie: ReadCookie, nowSeconds: number): CookiesSetDetails {
  const host = cookie.domain.replace(/^\./, "");
  // The URL says who set it, for a store that binds cookies to their scheme.
  const scheme = cookie.secure || !cookie.source_insecure ? "https" : "http";
  return {
    url: `${scheme}://${host}${cookie.path || "/"}`,
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || "/",
    secure: cookie.secure,
    httpOnly: cookie.http_only,
    sameSite: cookie.same_site ? SAME_SITE[cookie.same_site] : "unspecified",
    ...(cookie.host_only ? {} : { domain: cookie.domain }),
    // Electron would drop a session cookie at quit; here its copy is never made, so give it the date now.
    expirationDate: cookie.expires_unix ?? nowSeconds + SESSION_COOKIE_SECONDS,
  };
}

/** Profiles whose session Chromium has open this run; Electron can't close one, so its files can't change. */
const openSessions = new Set<string>();
const icons = new Map<string, string | null>();

type Args = { profile: string; path: string; cookies: ReadCookie[]; storageCopied: boolean; replaced: boolean };

const OPS: Record<string, (args: Args) => unknown> = {
  icon: async ({ path: file }) => {
    if (!icons.has(file)) {
      // app.getFileIcon ends the whole app on macOS (SIGTRAP on Electron's build here), even for Safari.
      const icon = process.platform === "darwin" ? nativeImage.createThumbnailFromPath(file, { width: 64, height: 64 }) : app.getFileIcon(file, { size: "large" });
      icons.set(file, await icon.then((image) => image.toDataURL(), () => null));
    }
    return icons.get(file) ?? null;
  },
  opened: ({ profile }) => openSessions.has(profile),
  // Importing over a profile: its sign-ins go first, and its site storage unless the import's was just copied in.
  clear: async ({ profile, storageCopied }) => {
    const target = session.fromPartition(profilePartition(profile));
    const storages = ["cookies", "cachestorage", "serviceworkers", ...(storageCopied ? [] : ["localstorage", "indexdb"])];
    await target.clearStorageData({ storages: storages as never });
    target.flushStorageData();
  },
  /** One batch; a cookie the store refuses is left out. */
  cookies: async ({ profile, cookies }) => {
    const target = session.fromPartition(profilePartition(profile));
    const now = Math.floor(Date.now() / 1000);
    await Promise.allSettled(cookies.map((cookie) => target.cookies.set(cookieDetails(cookie, now))));
  },
  settled: async ({ profile, replaced }) => {
    const target = session.fromPartition(profilePartition(profile));
    await target.cookies.flushStore();
    // Their pages were signed in as someone else: the page said they would reload.
    if (!replaced) return;
    for (const contents of webContents.getAllWebContents()) {
      if (contents.session === target && contents.getType() === "webview") contents.reload();
    }
  },
  restart: () => {
    app.relaunch();
    app.quit();
  },
  access: () => {
    if (process.platform === "darwin") void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
  },
};

export function installBrowserImport(): void {
  // Before any session opens.
  applyStagedStorage(path.join(app.getPath("userData"), "browser-import-staged"), path.join(app.getPath("userData"), "Partitions"), () => {});
  app.on("session-created", (created) => {
    const profile = profileOfStorage(created.storagePath);
    if (profile) openSessions.add(profile);
  });
  handleFromApp("brigadier:browser-import", (_event, op: string, args: Args) => {
    const run = OPS[op];
    if (!run) throw new Error(`No browser import operation ${op}`);
    return run(args);
  });
}
