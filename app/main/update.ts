// The app's own updates, from GitHub releases [D2003]: electron-updater checks and downloads in the background, and the
// sidebar's pill offers "Restart to update". The restart replaces only the app: the daemon and the hosts outlive it, and
// the new app's `brigadierd --install` hands its build over to them (crates/daemon/src/install.rs) [D60].
import { execFile } from "node:child_process";
import path from "node:path";

import { app, autoUpdater as native, BrowserWindow, ipcMain } from "electron";
import { autoUpdater } from "electron-updater";

import { allowQuit } from "./tray";

/** As the agents' check (app/ui/src/sidebar/updates.tsx): a minute after launch, then this often. */
const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;

/** The version downloaded and ready, and whether it waits for computer use to end. */
type AppUpdate = { current: string; version: string; waiting: boolean } | null;

let ready: string | null = null;
let computer = false;
let restarting = false;

const state = (): AppUpdate => (ready ? { current: app.getVersion(), version: ready, waiting: computer } : null);
const tell = () => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("app-update", state());
};

/** Only a Mac bundle signed with a Team ID updates: Squirrel.Mac refuses an update to an ad hoc one anyway. */
function updatable(): Promise<boolean> {
  if (process.platform !== "darwin") return Promise.resolve(true);
  const bundle = path.resolve(process.execPath, "../../..");
  return new Promise((done) =>
    execFile("/usr/bin/codesign", ["-dv", bundle], (_error, _out, err) => done(/^TeamIdentifier=(?!not set)\S+/m.test(String(err)))),
  );
}

export function serveUpdates(): void {
  ipcMain.handle("app-update", state);
  // Computer use's helper runs from inside the bundle and ends with the daemon it serves, which the new app replaces:
  // the restart waits until no agent uses the computer (proposed).
  ipcMain.on("using-computer", (_event, holder: unknown) => {
    computer = holder != null;
    if (ready) tell();
  });
  ipcMain.on("restart-to-update", () => {
    if (!ready || computer || restarting) return;
    // Once: on macOS Squirrel takes the download first, and a second click would install twice.
    restarting = true;
    autoUpdater.quitAndInstall(true, true);
  });
  // Before the windows close: closing otherwise only hides them (tray.ts), and the quit stops.
  native.on("before-quit-for-update", allowQuit);
  // A dev run never checks, and an unsigned Mac build doesn't either [D131].
  if (!app.isPackaged) return;
  void updatable().then((yes) => {
    if (!yes) return console.warn("updates: off, this build isn't signed with a Team ID");
    // Installed only from the pill, so never while an agent uses the computer.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on("update-downloaded", ({ version }) => {
      ready = version;
      tell();
    });
    // Quiet: a log line, no dialog.
    autoUpdater.on("error", (error) => console.warn("updates:", error.message));
    const check = () => void autoUpdater.checkForUpdates().catch(() => {});
    setTimeout(() => {
      check();
      setInterval(check, CHECK_EVERY_MS);
    }, FIRST_CHECK_MS);
  });
}
