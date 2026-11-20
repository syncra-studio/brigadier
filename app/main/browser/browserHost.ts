// The browser's security foundations: which pages may be guests, what they may have, and what they keep.
// Browser features come by section.
import path from "node:path";

import { app, session } from "electron";

import { handleFromApp, refuseUnsafeSwitches, setAppPage } from "./appPage";
import { watchProfileCookies } from "./browserClearData";
import { installBrowserAgent, watchGuest, watchNetwork } from "./browserAgent";
import { watchDownloads } from "./browserDownloads";
import { installBrowserImport } from "./browserImport";
import { installBrowserDevtools, watchDevToolsLinks } from "./browserDevtools";
import { installDurableStorage, keepStorageOf } from "./durableStorage";
import { installGuestFavicon } from "./guestFavicon";
import { installGuestKeys } from "./guestKeys";
import { installGuestSwipe } from "./guestSwipe";
import { installGuest, webOrBlank } from "./guestPopups";
import { installLocalCerts } from "./localCerts";
import { applyAppSessionPolicy, applyPermissionPolicy, installPermissionAnswers } from "./permissions";
import { isDeleting, installProfileStore } from "./profileStore";
import { isProfilePartition, profilePartition } from "./profiles";
import { keepSessionCookies } from "./sessionCookies";

const guestPasskeyPath = path.join(__dirname, "guestPasskey.js");

/** The partitions main has named for a profile: the only sessions a guest may have. */
const profileSessions = new Set<string>();

/** Before the window opens, so its page's will-attach-webview is guarded. `origin` is the app's page. */
export function installBrowserHost(origin: string): void {
  refuseUnsafeSwitches();
  setAppPage(origin);
  installDurableStorage();
  installPermissionAnswers();
  installGuestFavicon();
  installBrowserDevtools();
  installProfileStore();
  installBrowserAgent();
  installBrowserImport();
  installLocalCerts();
  app.on("render-process-gone", (_event, contents, details) => {
    console.error("A renderer is gone:", contents.getType(), contents.getURL(), details);
  });
  app.on("child-process-gone", (_event, details) => console.error("A child process is gone:", details));

  // Ready has come, so the app's own session was made before this could hear it.
  applyAppSessionPolicy(session.defaultSession);
  app.on("session-created", (created) => {
    if (!isProfilePartition(created.storagePath)) {
      applyAppSessionPolicy(created);
      return;
    }
    applyPermissionPolicy(created);
    // Pages see plain Chrome: sites treat an "Electron" or "Brigadier" agent as an embedded app, and Google may drop an imported session for it [D728].
    created.setUserAgent(created.getUserAgent().replace(/ (Electron|Brigadier)\/\S+/g, ""));
    keepSessionCookies(created);
    watchProfileCookies(created);
    if (process.platform === "darwin") created.registerPreloadScript({ type: "frame", filePath: guestPasskeyPath });
    watchNetwork(created);
    watchDownloads(created);
  });

  app.on("web-contents-created", (_event, contents) => {
    keepStorageOf(contents);
    if (contents.getType() === "webview") {
      installGuestKeys(contents);
      installGuestSwipe(contents);
      installGuest(contents);
      watchGuest(contents);
      watchDevToolsLinks(contents);
    }
    contents.on("will-attach-webview", (attach, preferences, params) => {
      if (!profileSessions.has(params.partition ?? "") || !webOrBlank(params.src ?? "")) {
        console.warn("A guest refused:", params.partition, params.src);
        attach.preventDefault();
        return;
      }
      delete preferences.preload;
      preferences.nodeIntegration = false;
      // Sandboxed, so no Node reaches any frame: this only lets a frame preload (the passkey one) run in subframes too.
      preferences.nodeIntegrationInSubFrames = true;
      preferences.contextIsolation = true;
      preferences.sandbox = true;
      preferences.webSecurity = true;
      preferences.allowRunningInsecureContent = false;
    });
  });

  handleFromApp("brigadier:profile-partition", (_event, profileId: string) => {
    if (isDeleting(profileId)) throw new Error("This profile is being deleted");
    const partition = profilePartition(profileId);
    profileSessions.add(partition);
    return partition;
  });
}
