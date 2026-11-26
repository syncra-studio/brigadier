// Only supervises: opens the window, starts the daemon, wires the page to the utility process. The
// exceptions are what only a main process can do: the native folder picker, staging the window for the
// first launch's intro (intro.ts), macOS notices and the Dock badge (notices.ts) and the menu bar's item (tray.ts) (D19, D40, D71, D200).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { installBrowserHost } from "./browser/browserHost";
import { holdForIntro } from "./intro";
import { type LocationAddon, useLocationAddon } from "./browser/browserPermissionsOs";
import { serveNotices } from "./notices";
import { type ScrollAddon, useScrollAddon, watchScrolls } from "./scrolls";
import { keepOnClose, serveTray } from "./tray";

import { app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, net, protocol, shell, utilityProcess, type UtilityProcess } from "electron";

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
const themeForeground = /--color-foreground:\s*([^;]+);/.exec(theme)![1];
// Dev only: BRIGADIER_FAKE_PLATFORM=win32 draws the Windows layout on a Mac, with stand-in caption buttons in the page.
const platform = (!app.isPackaged && process.env.BRIGADIER_FAKE_PLATFORM) || process.platform;
// The titlebar row's height, the theme's, and the traffic lights' top: their centre (y + 7) on its middle line, with
// its controls and tabs' [D823 D832].
const TAB_BAR = Number(/--spacing-tab-bar:\s*([\d.]+)rem;/.exec(theme)![1]) * 16;
const LIGHTS_Y = TAB_BAR / 2 - 7;
// How long a window may take to paint before it's shown anyway [D285].
const FIRST_PAINT_MS = 3000;
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
// The app's addon (crates/panel), loaded once. Loading it readies the folder picker: the first open panel of a run
// loads its frameworks, about half a second, paid off the user's click so Choose folder and Change open at once (the
// old app's warm_folder_picker) [D389]. It also tells Settings what macOS lets notices do [D611].
let addon: ({ notifications?: () => string | null } & ScrollAddon & LocationAddon) | undefined;
function panel(): typeof addon {
  if (addon || process.platform !== "darwin") return addon;
  addon = {};
  const file = app.isPackaged ? path.join(process.resourcesPath, "bin/libbrigadier_panel.dylib") : path.join(__dirname, "../../../target/debug/libbrigadier_panel.dylib");
  try {
    process.dlopen({ exports: addon } as NodeJS.Module, file);
    useScrollAddon(addon);
  } catch (error) {
    console.error("Could not load the app's addon:", error);
  }
  return addon;
}
const warmFolderPanel = () => void setTimeout(panel, 1500);

function startDaemon(): void {
  const daemon = spawn(daemonPath, daemonArgs, { detached: true, stdio: "ignore" });
  daemon.once("error", (error) => console.error("Could not start the daemon:", error));
  daemon.unref();
}

// A plain name: a session's or an attachment's id, so a path can't climb out of its folder.
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

/**
 * An attachment's file, by `/attachment/<home|session id>/<attachment id>`: only from Home's draft folder or that
 * session's own `attachments/`, `draft-attachments/` and `viewed/` (a thread's linked images), so the page shows them under its own origin [D127, D290].
 */
function attachmentFile(pathname: string): string | null {
  const [, kind, owner, id] = pathname.split("/");
  if (kind !== "attachment" || !PLAIN.test(owner ?? "") || !PLAIN.test(id ?? "")) return null;
  const folders = owner === "home" ? [path.join(dataDir, "home-draft-attachments")] : ["attachments", "draft-attachments", "viewed"].map((name) => path.join(dataDir, "sessions", owner, name));
  for (const folder of folders) {
    try {
      const [name] = readdirSync(path.join(folder, id));
      if (name) return path.join(folder, id, name);
    } catch {
      // Not in this one.
    }
  }
  return null;
}

/**
 * A note's image, by `/note-image/<note>/<name>`: only from that note's own `<note>.images/`, in whichever notes folder
 * holds it, as Rust finds a note; never through a link.
 */
function noteImage(pathname: string): string | null {
  const [, kind, note = "", escaped = ""] = pathname.split("/");
  if (kind !== "note-image" || !PLAIN.test(note)) return null;
  let name: string;
  try {
    name = decodeURIComponent(escaped);
  } catch {
    return null;
  }
  if (name.startsWith(".") || /[/\\\0]/.test(name) || !/\.(png|jpe?g|gif|webp)$/i.test(name)) return null;
  const under = (parent: string) => {
    try {
      return readdirSync(path.join(dataDir, parent)).map((id) => path.join(dataDir, parent, id, "notes"));
    } catch {
      return [];
    }
  };
  for (const notes of [...under("projects"), path.join(dataDir, "notes"), path.join(dataDir, "home-notes"), ...under("sessions")]) {
    const folder = path.join(notes, `${note}.images`);
    const file = path.join(folder, name);
    if (existsSync(file)) return realpathSync(file) === path.join(realpathSync(notes), `${note}.images`, name) ? file : null;
  }
  return null;
}

// A project's logo: the first of these names, then the shallowest, up to four folders down, so public/favicon/,
// Next's src/app/ and a monorepo's apps/web/public/ count; dependencies, build output and hidden folders are skipped [new-design, D505].
const ICON_NAMES = ["favicon.svg", "favicon.png", "favicon.ico", "logo.svg", "logo.png", "icon.svg", "icon.png"];
const ICON_SKIP = new Set(["node_modules", "target", "dist", "build", "out", "vendor", "Pods"]);
// Each project's logo, looked for once a run. shortcut: a logo added or removed shows after a restart, watch the folder if that bites.
const projectIcons = new Map<string, Promise<string | null>>();

async function findIcon(folder: string): Promise<string | null> {
  let found: string | null = null;
  let rank = ICON_NAMES.length;
  // At most this many folders read, so a project at a huge folder (the home folder) still answers quickly.
  let budget = 2000;
  for (let depth = 0, level = [folder]; depth <= 4 && rank > 0 && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (budget-- === 0) return found;
      // Only plain files and folders, never links, so nothing outside the project's folder is read.
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const at = ICON_NAMES.indexOf(entry.name);
        if (entry.isFile() && at !== -1 && at < rank) [rank, found] = [at, path.join(dir, entry.name)];
        else if (entry.isDirectory() && !entry.name.startsWith(".") && !ICON_SKIP.has(entry.name)) next.push(path.join(dir, entry.name));
      }
    }
    level = next;
  }
  return found;
}

/** A project's logo, by `/project-icon/<project id>`: its folder from projects.json, never from the page, and a file only inside it. */
function projectIcon(pathname: string): Promise<string | null> {
  const [, kind, id] = pathname.split("/");
  if (kind !== "project-icon" || !PLAIN.test(id ?? "")) return Promise.resolve(null);
  if (!projectIcons.has(id!)) {
    try {
      const projects: { id: string; folder: string }[] = JSON.parse(readFileSync(path.join(dataDir, "projects.json"), "utf8")).projects;
      projectIcons.set(id!, findIcon(realpathSync(projects.find((project) => project.id === id)!.folder)));
    } catch {
      // No such project, or its folder is gone: asked again next time, as it may be added.
      return Promise.resolve(null);
    }
  }
  return projectIcons.get(id!)!;
}

/** An SVG can carry script: none runs, nothing loads, and no file is read as another kind. A fetch's headers are fixed, so they're copied. */
function locked(fetched: Response): Response {
  const headers = new Headers(fetched.headers);
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(fetched.body, { status: fetched.status, headers });
}

function serveUi(): void {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    if (url.host === APP_ID && url.pathname.startsWith("/attachment/")) {
      const file = attachmentFile(url.pathname);
      if (!file) return new Response(null, { status: 404 });
      const fetched = await net.fetch(pathToFileURL(file).toString());
      return /\.svg$/i.test(file) ? locked(fetched) : fetched;
    }
    if (url.host === APP_ID && url.pathname.startsWith("/note-image/")) {
      const file = noteImage(url.pathname);
      return file ? net.fetch(pathToFileURL(file).toString()) : new Response(null, { status: 404 });
    }
    // A person's picture as Rust keeps it from a PR read, `/avatar/<login>` [D615].
    if (url.host === APP_ID && url.pathname.startsWith("/avatar/")) {
      const login = url.pathname.split("/")[2] ?? "";
      const file = path.join(dataDir, "avatars", `${login}.png`);
      return PLAIN.test(login) && existsSync(file) ? net.fetch(pathToFileURL(file).toString()) : new Response(null, { status: 404 });
    }
    if (url.host === APP_ID && url.pathname.startsWith("/project-icon/")) {
      // `/project-icon/<id>/<file>`: the image picked in its settings, as Rust copied it into the project's folder.
      const [, , id = "", picked] = url.pathname.split("/");
      const own = picked !== undefined && PLAIN.test(id) && /^icon-\d+(-\d+)?\.(png|jpe?g|gif|webp|svg)$/.test(picked) ? path.join(dataDir, "projects", id, picked) : null;
      const file = own ? (existsSync(own) ? own : null) : await projectIcon(url.pathname);
      // A logo found once may since have gone: a 404 too, with the same headers.
      const missing = () => new Response(null, { status: 404 });
      const fetched = file ? await net.fetch(pathToFileURL(file).toString()).catch(missing) : missing();
      return locked(fetched);
    }
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
    // The page's fill, one surface with the sidebar, before and under it.
    backgroundColor: hold ? introColours.clear : themeBackground,
    // Shown at its first paint, the launch screen, so an empty window never shows before it [D285].
    show: false,
    ...(hold ? { transparent: true } : {}),
    titleBarStyle: "hidden",
    // The lights' centre is y + 7: this puts it on the titlebar's middle line (theme's --spacing-titlebar). The
    // sidebar moves them onto the tab bar's line once it shows (traffic-lights).
    // acceptFirstMouse: a click on the window while another app is in front acts as well as bringing it forward;
    // without it a click on the chat's "…" over a window already showing its tooltip did nothing [D211].
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 16, y: 13 }, acceptFirstMouse: true } : {}),
    // Windows draws its own caption buttons over the tab bar's end, in the theme's colours [new-design].
    ...(process.platform === "win32" ? { titleBarOverlay: { height: TAB_BAR, color: themeBackground, symbolColor: themeForeground } } : {}),
    webPreferences: {
      additionalArguments: [`--brigadier-platform=${platform}`],
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The browser's pages are <webview>s of this page; main guards what each may be (browser/browserHost.ts).
      webviewTag: true,
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
  window.webContents.once("did-finish-load", () => {
    page = window.webContents;
    if (opened.length > 0) page.send("menu", "open-folders", opened.splice(0));
  });
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
  // A scroll's news for swiping Back and Forward (shell/titlebar.tsx): a mouse's, the fingers' lift, its end [D3110].
  watchScrolls(window.webContents, {
    begin: (trackpad) => trackpad || window.webContents.send("scroll", "mouse"),
    lift: () => window.webContents.send("scroll", "lift"),
    end: () => window.webContents.send("scroll", "end"),
  });
  // A reload starts with no tab bar until the new page says so.
  window.webContents.on("did-navigate", () => closesTab.delete(window.webContents));
  if (hold) holdForIntro(window, themeBackground, introColours);
  else {
    // One that never paints still shows, once.
    let pending = true;
    const show = (): void => {
      if (pending && !window.isDestroyed()) window.show();
      pending = false;
    };
    window.once("ready-to-show", show);
    setTimeout(show, FIRST_PAINT_MS);
  }
  // The Windows stand-in on a Mac has no traffic lights; the page draws its caption buttons.
  if (process.platform === "darwin" && platform !== "darwin") window.setWindowButtonVisibility(false);
  keepOnClose(window);
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
// A file the user picks, titled `title` and starting in `at`, or null; what it is for is checked in Rust.
ipcMain.handle("pick-file", async (event, { title, at }: { title: string; at?: string }) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const options = { title, message: title, defaultPath: at || app.getPath("home"), properties: ["openFile" as const] };
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
// A web link opens in the browser: from window.open, or from the page once a click's wait is over (a push, then its PR page),
// and a Browser tab's page, which may be a local server's (http:), as the old app's Open in external browser.
function openLink(url: string): void {
  if (/^https?:/.test(url)) void shell.openExternal(url);
}
ipcMain.on("open-link", (_event, url: string) => openLink(url));
// Saves a copy of a sent file where the user picks, starting in Downloads, as the old image viewer's Download [D2098].
ipcMain.handle("save-attachment", async (event, at: string, name: string) => {
  const file = attachmentFile(at) ?? noteImage(at);
  if (!file) throw new Error("This file is no longer here");
  const window = BrowserWindow.fromWebContents(event.sender);
  // A shown name ("Image #1", "photo.png (2)") keeps the file's own extension.
  const named = name.toLowerCase().endsWith(path.extname(file).toLowerCase()) ? name : `${name}${path.extname(file)}`;
  const options = { title: "Download image", defaultPath: path.join(app.getPath("downloads"), path.basename(named)) };
  const picked = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options));
  if (picked.canceled || !picked.filePath) return false;
  await copyFile(file, picked.filePath);
  return true;
});
// The page puts the traffic lights at its x, on the tab bar's line [new-design, D48].
ipcMain.on("traffic-lights", (event, x: number) => {
  if (process.platform === "darwin" && platform === "darwin") BrowserWindow.fromWebContents(event.sender)?.setWindowButtonPosition({ x, y: LIGHTS_Y });
});
// The windows whose ⌘W closes a tab (the tab bar says so) [D360].
const closesTab = new WeakSet<Electron.WebContents>();
ipcMain.on("closes-tab", (event, on: boolean) => void (on ? closesTab.add(event.sender) : closesTab.delete(event.sender)));

// The standard menus plus File › New Chat (⌘N) [D184 D282] and Add project's: File › Open Folder… (⌘O, the
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
          { label: "New Chat", accelerator: keysOf("new-session"), click: (_item, window) => tell(window as BrowserWindow | undefined, "new-session") },
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
          { label: "Toggle Summary", click: (_item, window) => tell(window as BrowserWindow | undefined, "toggle-summary") },
          { label: "Back", accelerator: keysOf("back"), click: (_item, window) => tell(window as BrowserWindow | undefined, "back") },
          { label: "Forward", accelerator: keysOf("forward"), click: (_item, window) => tell(window as BrowserWindow | undefined, "forward") },
        ],
      },
      // Off macOS the stock Window menu has its own Close on the same key.
      process.platform === "darwin" ? { role: "windowMenu" as const } : { label: "Window", submenu: [{ role: "minimize" as const }, { role: "zoom" as const }] },
    ]),
  );
}

// Folders opened with the app: Finder's Open With, the Dock, `open -a`; one that launches it comes before the window,
// so it waits for the page. The page takes them as ⌘O's [D165, D2004].
const opened: string[] = [];
let page: Electron.WebContents | null = null;
app.on("open-file", (event, file) => {
  event.preventDefault();
  if (page && !page.isDestroyed()) page.send("menu", "open-folders", [file]);
  else opened.push(file);
});

void app.whenReady().then(() => {
  setMenu();
  serveNotices(panel);
  useLocationAddon(panel);
  serveTray();
  startDaemon();
  serveUi();
  installBrowserHost(ORIGIN);
  openWindow();
});
