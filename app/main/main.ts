// Only supervises: opens the window, starts the daemon, wires the page to the utility process. The
// exceptions are what only a main process can do: the native folder picker, and staging the window
// for the first launch's intro (intro.ts) (D19, D40, D71).
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { holdForIntro } from "./intro";

import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, net, protocol, shell, utilityProcess, type UtilityProcess } from "electron";

const APP_NAME = "Brigadier";
const APP_ID = "sh.brigadier.app";
const ORIGIN = `app://${APP_ID}`;

const uiDir = path.join(__dirname, "../../ui");
const uiDist = path.join(uiDir, "dist");
// BRIGADIER_DATA points the app and its daemon at another data folder, as it does for the CLI.
const dataDir = process.env.BRIGADIER_DATA ?? path.join(app.getPath("appData"), APP_NAME);
const socketPath = path.join(dataDir, "daemon.sock");
// Packaged, the bundle's daemon installs its build outside the bundle and execs it there [D40].
const [daemonPath, daemonArgs] = app.isPackaged
  ? [path.join(process.resourcesPath, "bin/brigadierd"), ["--install"]]
  : [path.join(__dirname, "../../../target/debug/brigadierd"), []];

const theme = readFileSync(path.join(uiDir, "src/theme.css"), "utf8");
const themeBackground = /--color-background:\s*([^;]+);/.exec(theme)![1];
// The intro's staging: the desktop's dim, and the clear its window shows (intro.ts).
const introColours = { dim: /--color-intro-dim:\s*([^;]+);/.exec(theme)![1], clear: /--color-intro-clear:\s*([^;]+);/.exec(theme)![1] };

app.setName(APP_NAME);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
app.setPath("userData", path.join(dataDir, "chromium"));
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true } }]);

// The daemon decides: it exits at once if this build or a newer one already runs, and replaces an
// older one, which may answer but refuse this app.
function startDaemon(): void {
  const daemon = spawn(daemonPath, daemonArgs, { detached: true, stdio: "ignore" });
  daemon.once("error", (error) => console.error("Could not start the daemon:", error));
  daemon.unref();
}

function serveUi(): void {
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const file = path.join(uiDist, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
    if (url.host !== APP_ID || !file.startsWith(uiDist + path.sep)) return new Response(null, { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

// The intro plays until it has been seen once (profile.json, kept by the CLI): read only to hold the window.
function introSeen(): boolean {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, "profile.json"), "utf8")).intro_seen === true;
  } catch {
    return false;
  }
}

function openWindow(): void {
  // On macOS a first launch holds the window clear for the intro, which needs it transparent from birth.
  const hold = process.platform === "darwin" && !introSeen();
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: APP_NAME,
    backgroundColor: hold ? introColours.clear : themeBackground,
    ...(hold ? { transparent: true, show: false } : {}),
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // A web link (a sign-in's code page) opens in the browser; nothing opens in the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  let utility: UtilityProcess;
  const wire = (): void => {
    const { port1, port2 } = new MessageChannelMain();
    // A crashed or swapping page throws "Render frame was disposed"; its next load wires again.
    try {
      window.webContents.postMessage("daemon-port", null, [port2]);
    } catch (error) {
      console.warn("Page not ready for the daemon port:", error);
      return;
    }
    utility.postMessage(null, [port1]);
  };
  const fork = (): void => {
    utility = utilityProcess.fork(path.join(__dirname, "socket.js"), [socketPath]);
    utility.on("message", (message) => message === "down" && startDaemon());
    // A dead utility process must not leave the page showing a stale "connected".
    utility.once("exit", () => {
      if (window.isDestroyed()) return;
      fork();
      wire();
    });
  };
  fork();
  window.webContents.on("did-finish-load", wire);
  // A crash leaves the window blank; reloading draws it again and reconnects to the daemon.
  // shortcut: a page that crashes on every load reloads forever; add a backoff if that ever happens.
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("The page's renderer is gone:", details.reason);
    if (!window.isDestroyed()) window.webContents.reload();
  });
  if (hold) holdForIntro(window, themeBackground, introColours);
  void window.loadURL(`${ORIGIN}/`);
}

app.on("window-all-closed", () => app.quit());
// A folder the user picks, or null; what it is for is checked in Rust.
ipcMain.handle("pick-folder", async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const options = { defaultPath: app.getPath("home"), properties: ["openDirectory" as const, "createDirectory" as const] };
  const picked = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
  return picked.canceled ? null : (picked.filePaths[0] ?? null);
});
void app.whenReady().then(() => {
  startDaemon();
  serveUi();
  openWindow();
});
