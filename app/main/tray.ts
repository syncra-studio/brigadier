// The menu bar's Brigadier item, as the old app had it (its electron/main/tray.ts): Open Brigadier, the sessions
// running now (the page says which), Quit Brigadier. It is there from the start, which is what lets closing the
// window keep the app running, out of the Dock until the window shows again. Windows' notification area has it too, and
// closing hides there as well; on Linux closing quits, since a desktop without a tray host (GNOME without AppIndicator)
// would leave no way back, and the work runs on in the daemon either way.
// While an agent uses the computer, the icon wears a dot and the menu says who, with Stop and Open chat [D957].
import { readFileSync } from "node:fs";
import path from "node:path";

import { app, type BrowserWindow, ipcMain, Menu, nativeImage, Tray } from "electron";

/** A menu bar icon's height on macOS, in points: it draws the PNG by height, in its text colour. */
const ICON_POINTS = 18;
/** Longest title the Running list shows before cutting it with "…". */
const TITLE_CHARS = 48;

/** The app's own icon off macOS, for the item and the window, which a dev run has no packaged one for. */
const OWN_ICON = path.join(__dirname, `../icons/${process.platform === "win32" ? "icon.ico" : "icon.png"}`);

// Held here: a tray nobody holds is collected, and leaves the menu bar.
let tray: Tray | null = null;
let main: BrowserWindow | null = null;
let quitting = false;
let icons: { idle: Electron.NativeImage; using: Electron.NativeImage } | null = null;
let running: { id: string; title: string }[] = [];
let using: { id: string; chat: string; title: string } | null = null;

const cut = (text: string) => {
  const characters = [...text];
  return characters.length > TITLE_CHARS ? `${characters.slice(0, TITLE_CHARS - 1).join("").trimEnd()}…` : text;
};

function showMain(): void {
  if (!main || main.isDestroyed()) return;
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
}

/** Opens a session in the window, as a notice's click does (notices.ts). */
function openSession(id: string): void {
  showMain();
  main?.webContents.send("notice-click", id);
}

function setMenu(): void {
  if (icons) tray?.setImage(using ? icons.using : icons.idle);
  const computer = using;
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      ...(computer
        ? [
            { label: cut(`Using your computer · ${computer.title}`), enabled: false },
            // The page stops it, as the composer's Stop: the turn ends and lets the computer go [D907].
            { label: "Stop", click: () => main?.webContents.send("computer-stop", computer.id) },
            { label: "Open chat", click: () => openSession(computer.chat) },
            { type: "separator" as const },
          ]
        : []),
      { label: "Open Brigadier", click: showMain },
      { type: "separator" },
      ...(running.length === 0
        ? []
        : [
            { label: "Running", enabled: false },
            ...running.map(({ id, title }) => ({
              label: cut(title),
              click: () => openSession(id),
            })),
            { type: "separator" as const },
          ]),
      { label: "Quit Brigadier", click: () => app.quit() },
    ]),
  );
}

/** The item, once the app is ready. A desktop with no menu bar host just has no item, and closing the window quits. */
export function serveTray(): void {
  app.on("before-quit", () => (quitting = true));
  app.on("activate", showMain);
  app.on("second-instance", showMain);
  ipcMain.on("running", (_event, sessions: typeof running) => ((running = sessions), setMenu()));
  ipcMain.on("using-computer", (_event, holder: typeof using) => ((using = holder), setMenu()));
  try {
    const icon = (name: string) => {
      const png = readFileSync(path.join(__dirname, `../icons/${name}`));
      const image = nativeImage.createFromBuffer(png, { scaleFactor: nativeImage.createFromBuffer(png).getSize().height / ICON_POINTS });
      image.setTemplateImage(true);
      return image;
    };
    // The black mark is macOS's template image; elsewhere the app's own icon, as the old app had on Windows.
    if (process.platform === "darwin") icons = { idle: icon("tray.png"), using: icon("tray-active.png") };
    else {
      const own = nativeImage.createFromPath(OWN_ICON);
      icons = { idle: own, using: own };
    }
    tray = new Tray(icons.idle);
    tray.setToolTip(app.getName());
    // A click on Windows' item opens the app, as there; its menu is on the right button.
    if (process.platform === "win32") tray.on("click", showMain);
    setMenu();
  } catch (error) {
    console.warn("menu-bar item unavailable", error);
  }
}

/** Closing the app's window hides it, and the Dock icon with it, while the item can bring it back. */
export function keepOnClose(window: BrowserWindow): void {
  main = window;
  if (process.platform !== "darwin") window.setIcon(OWN_ICON);
  window.on("close", (event) => {
    if (quitting || !tray || process.platform === "linux") return;
    event.preventDefault();
    window.hide();
    app.dock?.hide();
  });
  window.on("show", () => {
    if (app.dock && !app.dock.isVisible()) void app.dock.show();
  });
}
