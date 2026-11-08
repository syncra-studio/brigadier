// Only supervises: opens the window, starts the daemon, wires the page to the utility process.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, MessageChannelMain, net, protocol, utilityProcess, type UtilityProcess } from "electron";

const APP_NAME = "Brigadier";
const APP_ID = "sh.brigadier.app";
const ORIGIN = `app://${APP_ID}`;

const uiDir = path.join(__dirname, "../../ui");
const uiDist = path.join(uiDir, "dist");
// BRIGADIER_DATA points the app and its daemon at another data folder, as it does for the CLI.
const dataDir = process.env.BRIGADIER_DATA ?? path.join(app.getPath("appData"), APP_NAME);
const socketPath = path.join(dataDir, "daemon.sock");
const daemonPath = path.join(__dirname, "../../../target/debug/brigadierd");

const themeBackground = /--color-background:\s*([^;]+);/.exec(readFileSync(path.join(uiDir, "src/theme.css"), "utf8"))![1];

app.setName(APP_NAME);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
app.setPath("userData", path.join(dataDir, "chromium"));
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true } }]);

// The daemon decides: it exits at once if this build or a newer one already runs, and replaces an
// older one, which may answer but refuse this app.
function startDaemon(): void {
  const daemon = spawn(daemonPath, { detached: true, stdio: "ignore" });
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

function openWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: APP_NAME,
    backgroundColor: themeBackground,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  let utility: UtilityProcess;
  const wire = (): void => {
    const { port1, port2 } = new MessageChannelMain();
    utility.postMessage(null, [port1]);
    window.webContents.postMessage("daemon-port", null, [port2]);
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
  void window.loadURL(`${ORIGIN}/`);
}

app.on("window-all-closed", () => app.quit());
void app.whenReady().then(() => {
  startDaemon();
  serveUi();
  openWindow();
});
