// The menu bar's Brigadier item, as the old app had it (its electron/main/tray.ts): Open Brigadier, the sessions
// running now (the page says which), Quit Brigadier. It is there from the start, which is what lets closing the
// window keep the app running, out of the Dock until the window shows again. macOS only, as the build is.
import { readFileSync } from "node:fs";
import path from "node:path";

import { app, type BrowserWindow, ipcMain, Menu, nativeImage, Tray } from "electron";

/** A menu bar icon's height on macOS, in points: it draws the PNG by height, in its text colour. */
const ICON_POINTS = 18;
/** Longest title the Running list shows before cutting it with "…". */
const TITLE_CHARS = 48;

// Held here: a tray nobody holds is collected, and leaves the menu bar.
let tray: Tray | null = null;
let main: BrowserWindow | null = null;
let quitting = false;

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

function setMenu(running: { id: string; title: string }[]): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Brigadier", click: showMain },
      { type: "separator" },
      ...(running.length === 0
        ? []
        : [
            { label: "Running", enabled: false },
            ...running.map(({ id, title }) => ({
              label: cut(title),
              // The page opens a session by id on this, as for a notice's click (notices.ts).
              click: () => {
                showMain();
                main?.webContents.send("notice-click", id);
              },
            })),
            { type: "separator" as const },
          ]),
      { label: "Quit Brigadier", click: () => app.quit() },
    ]),
  );
}

/** The item, once the app is ready. A desktop with no menu bar host just has no item, and closing the window quits. */
export function serveTray(): void {
  if (process.platform !== "darwin") return;
  app.on("before-quit", () => (quitting = true));
  app.on("activate", showMain);
  ipcMain.on("running", (_event, running: { id: string; title: string }[]) => setMenu(running));
  try {
    const png = readFileSync(path.join(__dirname, "../icons/tray.png"));
    const image = nativeImage.createFromBuffer(png, { scaleFactor: nativeImage.createFromBuffer(png).getSize().height / ICON_POINTS });
    image.setTemplateImage(true);
    tray = new Tray(image);
    tray.setToolTip(app.getName());
    setMenu([]);
  } catch (error) {
    console.warn("menu-bar item unavailable", error);
  }
}

/** Closing the app's window hides it, and the Dock icon with it, while the item can bring it back. */
export function keepOnClose(window: BrowserWindow): void {
  main = window;
  window.on("close", (event) => {
    if (quitting || !tray) return;
    event.preventDefault();
    window.hide();
    app.dock?.hide();
  });
  window.on("show", () => {
    if (app.dock && !app.dock.isVisible()) void app.dock.show();
  });
}
