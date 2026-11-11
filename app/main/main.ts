// Only supervises: opens the window, starts the daemon, wires the page to the utility process. The
// exceptions are what only a main process can do: the native folder picker, staging the window for the
// first launch's intro (intro.ts), and macOS notices and the Dock badge (notices.ts) (D19, D40, D71, D200).
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { holdForIntro } from "./intro";
import { serveNotices } from "./notices";

import { app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, net, protocol, shell, utilityProcess, type UtilityProcess } from "electron";

const APP_NAME = "Brigadier";
const APP_ID = "sh.brigadier.app";
const ORIGIN = `app://${APP_ID}`;

const uiDir = path.join(__dirname, "../../ui");
const uiDist = path.join(uiDir, process.env.BRIGADIER_UI_DIST ?? "dist");
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
// The menu's keys, from the one list of shortcuts the page shows and matches too (app/ui/src/shortcuts.ts) [D2013].
const shortcuts: { id: string; keys: string[] }[] = JSON.parse(readFileSync(path.join(uiDir, "src/shortcuts.json"), "utf8"));
const keysOf = (id: string) => shortcuts.find((shortcut) => shortcut.id === id)!.keys[0];

app.setName(APP_NAME);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
app.setPath("userData", path.join(dataDir, "chromium"));
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true } }]);

// The daemon decides: it exits at once if this build or a newer one already runs, and replaces an
// older one, which may answer but refuse this app.
// The first open panel of a run loads its frameworks, about half a second. Paid once, off the
// user's click, so Choose folder and Change open at once (the old app's warm_folder_picker) [D389].
let panelWarmed = false;
function warmFolderPanel(): void {
  if (panelWarmed || process.platform !== "darwin") return;
  panelWarmed = true;
  const file = app.isPackaged ? path.join(process.resourcesPath, "bin/libbrigadier_panel.dylib") : path.join(__dirname, "../../../target/debug/libbrigadier_panel.dylib");
  setTimeout(() => {
    try {
      process.dlopen({ exports: {} } as NodeJS.Module, file);
    } catch (error) {
      console.error("Could not ready the folder picker:", error);
    }
  }, 1500);
}

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
    // The lights' centre is y + 7: this puts it on the titlebar's middle line (theme's --spacing-titlebar).
    trafficLightPosition: { x: 16, y: 13 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // A web link (a sign-in's code page) opens in the browser; nothing opens in the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url);
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
  window.webContents.once("did-finish-load", warmFolderPanel);
  // A crash leaves the window blank; reloading draws it again and reconnects to the daemon.
  // shortcut: a page that crashes on every load reloads forever; add a backoff if that ever happens.
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("The page's renderer is gone:", new Date().toISOString(), details);
    if (!window.isDestroyed()) window.webContents.reload();
  });
  // The traffic lights go in full screen, so the titlebar's buttons move to its start (theme.css).
  const tellFullScreen = (): void => window.webContents.send("full-screen", window.isFullScreen());
  window.on("enter-full-screen", tellFullScreen);
  window.on("leave-full-screen", tellFullScreen);
  window.webContents.on("did-finish-load", tellFullScreen);
  // A reload starts with no tab bar until the new page says so.
  window.webContents.on("did-navigate", () => closesTab.delete(window.webContents));
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
// Folders the user picks, several with `multi`, starting at `at` (`~/` is home); what they're for is checked in Rust.
async function pickFolders(window: BrowserWindow | null, { at, multi }: { at?: string; multi?: boolean } = {}): Promise<string[]> {
  const home = app.getPath("home");
  const defaultPath = at ? at.replace(/^~(?=\/|$)/, home) : home;
  const properties = ["openDirectory" as const, "createDirectory" as const, ...(multi ? ["multiSelections" as const] : [])];
  const picked = await (window ? dialog.showOpenDialog(window, { defaultPath, properties }) : dialog.showOpenDialog({ defaultPath, properties }));
  return picked.canceled ? [] : picked.filePaths;
}
ipcMain.handle("pick-folders", (event, options) => pickFolders(BrowserWindow.fromWebContents(event.sender), options));
ipcMain.on("text-undo", (event) => event.sender.undo());
// While Settings › Keyboard shortcuts records a press, the menu's own keys (⌘N, ⌘W…) don't fire either.
ipcMain.on("ignore-menu-keys", (event, on: boolean) => event.sender.setIgnoreMenuShortcuts(on));
// A web link opens in the browser: from window.open, or from the page once a click's wait is over (a push, then its PR page).
function openLink(url: string): void {
  if (/^https:/.test(url)) void shell.openExternal(url);
}
ipcMain.on("open-link", (_event, url: string) => openLink(url));
// The windows whose ⌘W closes a tab (the tab bar says so) [D360].
const closesTab = new WeakSet<Electron.WebContents>();
ipcMain.on("closes-tab", (event, on: boolean) => void (on ? closesTab.add(event.sender) : closesTab.delete(event.sender)));

// The standard menus plus File › New Session (⌘N) [D184] and Add project's: File › Open Folder… (⌘O, the
// picker, several at once) and View › Add project…, each told to the page, which does the rest [D165].
function setMenu(): void {
  const tell = (window: BrowserWindow | undefined, command: string, paths?: string[]) => window?.webContents.send("menu", command, paths);
  const closeTabOrWindow = (window: BrowserWindow | undefined) => (window && closesTab.has(window.webContents) ? tell(window, "close-tab") : window?.close());
  const openFolder = async (window: BrowserWindow | undefined) => {
    const paths = await pickFolders(window ?? null, { multi: true });
    if (paths.length > 0) tell(window, "open-folders", paths);
  };
  // macOS's standard app menu, with Settings… after About [D2022].
  const appMenu: Electron.MenuItemConstructorOptions = {
    label: APP_NAME,
    submenu: [
      { role: "about" },
      { type: "separator" },
      { label: "Settings…", accelerator: keysOf("settings"), click: (_item, window) => tell(window as BrowserWindow | undefined, "settings") },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [appMenu] : []),
      {
        label: "File",
        submenu: [
          { label: "New Session", accelerator: keysOf("new-session"), click: (_item, window) => tell(window as BrowserWindow | undefined, "new-session") },
          { type: "separator" },
          { label: "Open Folder…", accelerator: keysOf("open-folder"), click: (_item, window) => void openFolder(window as BrowserWindow | undefined) },
          { type: "separator" },
          // A window with a tab to close says so; anywhere else (Accounts, onboarding, Home's Chat tab) ⌘W closes the window.
          { label: "Close", accelerator: keysOf("close"), click: (_item, window) => closeTabOrWindow(window as BrowserWindow | undefined) },
          ...(process.platform === "darwin" ? [] : [{ role: "quit" as const }]),
        ],
      },
      {
        role: "editMenu",
        submenu: [
          { label: "Undo", accelerator: keysOf("undo-archive"), click: (_item, window) => tell(window as BrowserWindow | undefined, "undo") },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          ...(process.platform === "darwin" ? [
            { role: "pasteAndMatchStyle" as const },
            { role: "delete" as const },
            { role: "selectAll" as const },
            { type: "separator" as const },
            { label: "Substitutions", submenu: [{ role: "showSubstitutions" as const }, { type: "separator" as const }, { role: "toggleSmartQuotes" as const }, { role: "toggleSmartDashes" as const }, { role: "toggleTextReplacement" as const }] },
            { label: "Speech", submenu: [{ role: "startSpeaking" as const }, { role: "stopSpeaking" as const }] },
          ] : [{ role: "delete" as const }, { type: "separator" as const }, { role: "selectAll" as const }]),
        ],
      },
      {
        label: "View",
        submenu: [
          { label: "Add project…", click: (_item, window) => tell(window as BrowserWindow | undefined, "add-project") },
          { type: "separator" },
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
          { type: "separator" },
          { label: "Toggle Sidebar", accelerator: keysOf("sidebar"), click: (_item, window) => tell(window as BrowserWindow | undefined, "toggle-sidebar") },
          { label: "Back", accelerator: keysOf("back"), click: (_item, window) => tell(window as BrowserWindow | undefined, "back") },
          { label: "Forward", accelerator: keysOf("forward"), click: (_item, window) => tell(window as BrowserWindow | undefined, "forward") },
        ],
      },
      // Off macOS the stock Window menu has its own Close on the same key.
      process.platform === "darwin" ? { role: "windowMenu" as const } : { label: "Window", submenu: [{ role: "minimize" as const }, { role: "zoom" as const }] },
    ]),
  );
}

void app.whenReady().then(() => {
  setMenu();
  serveNotices();
  startDaemon();
  serveUi();
  openWindow();
});
