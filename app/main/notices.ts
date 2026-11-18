// macOS notices and the Dock badge for the page [D200, D2012]: what only a main process can do. The page decides
// what to send (from Rust's row marks); this shows it, plays macOS's own sound unless silent [D2020], says what
// macOS did with it, which is all Electron can tell of the permission [D2024], and opens the session on a click.
import { app, BrowserWindow, ipcMain, Notification, shell } from "electron";

// Kept until they close, or a click on one that was collected goes nowhere.
const shown = new Set<Notification>();

export function serveNotices(panel: () => { notifications?: () => string | null } | undefined): void {
  ipcMain.handle("notify", (event, { title, body, silent, session }: { title: string; body: string; silent: boolean; session?: string }) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const notice = new Notification({ title, body, silent });
    shown.add(notice);
    notice.on("click", () => {
      shown.delete(notice);
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      if (session) window.webContents.send("notice-click", session);
    });
    notice.on("close", () => shown.delete(notice));
    return new Promise<"shown" | "blocked" | "failed">((resolve) => {
      notice.once("show", () => resolve("shown"));
      notice.once("failed", (_event, error: string) => {
        shown.delete(notice);
        // UNErrorCodeNotificationsNotAllowed's words: Brigadier is off in System Settings › Notifications.
        resolve(/not allowed/i.test(error) ? "blocked" : "failed");
      });
      notice.show();
    });
  });
  ipcMain.on("badge", (_event, count: number) => app.dock?.setBadge(count > 0 ? String(count) : ""));
  // What macOS lets notices do now, asked of it each time [D611].
  ipcMain.handle("notification-state", () => panel()?.notifications?.() ?? null);
  ipcMain.on("open-notification-settings", () => void shell.openExternal("x-apple.systempreferences:com.apple.Notifications-Settings.extension"));
  // Settings › Computer use's two panes, the old app's URLs; nothing else is opened.
  ipcMain.on("open-privacy-settings", (_event, pane: unknown) => {
    const name = pane === "accessibility" ? "Privacy_Accessibility" : pane === "screenRecording" ? "Privacy_ScreenCapture" : null;
    if (name) void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${name}`);
  });
}
