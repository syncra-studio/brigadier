// What counts as the app's own page, the one thing that gets the shell's IPC. A guest has no preload to reach
// it with; these checks hold if that ever stops being so, or if a window of ours is sent somewhere else.
import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";

let page: URL | null = null;

/** The app's page lives at `origin` (main.ts's ORIGIN). */
export function setAppPage(origin: string): void {
  page = new URL(origin);
}

/** By scheme and host, since Node gives `app:` an origin of "null". */
export function isAppPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return page !== null && parsed.protocol === page.protocol && parsed.host === page.host;
  } catch {
    return false;
  }
}

/** The top frame of one of the app's windows, showing the app's page. A popup is a window too, so the address counts. */
export function fromAppPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return event.sender.getType() === "window" && frame !== null && frame.parent === null && isAppPage(frame.url);
}

const refused = (channel: string, event: IpcMainEvent | IpcMainInvokeEvent) =>
  console.warn("IPC refused:", channel, event.sender.id, event.senderFrame?.url ?? null);

export function handleFromApp(channel: string, handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (fromAppPage(event)) return handler(event, ...(args as never[]));
    refused(channel, event);
    throw new Error(`${channel} is for the app's own page`);
  });
}

const REFUSED_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe", "no-sandbox", "disable-web-security"];

/** A packaged app won't run with a debug port or with a page's protections off, so a shell can't undo them on the user's signed-in pages. */
export function refuseUnsafeSwitches(): void {
  if (!app.isPackaged) return;
  const given = REFUSED_SWITCHES.find((name) => app.commandLine.hasSwitch(name));
  if (!given) return;
  console.error(`brigadier: refusing to start with --${given}`);
  app.exit(1);
}
