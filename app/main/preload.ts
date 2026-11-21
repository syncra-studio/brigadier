import { contextBridge, ipcRenderer, webUtils } from "electron";

// A MessagePort can't cross contextBridge, so it reaches the page as a transfer.
ipcRenderer.on("daemon-port", (event) => {
  window.postMessage("daemon-port", window.location.origin, event.ports);
});

// Native Undo roles can bypass page keydown on macOS; the page gets first refusal, then text undo.
ipcRenderer.on("menu", (_event, command) => {
  if (command !== "undo") return;
  const target = document.activeElement ?? document.body;
  const key = new KeyboardEvent("keydown", { key: "z", code: "KeyZ", metaKey: process.platform === "darwin", ctrlKey: process.platform !== "darwin", bubbles: true, cancelable: true });
  if (target.dispatchEvent(key)) ipcRenderer.send("text-undo");
});

// What the page asks of main (main.ts): the native folder and file pickers, the menu's commands, and the intro's window staging (intro.ts).
ipcRenderer.on("full-screen", (_event, on: boolean) => document.documentElement.toggleAttribute("data-fullscreen", on));
ipcRenderer.on("key", (_event, on: boolean) => document.documentElement.toggleAttribute("data-key", on));

// The platform main draws the window for, which a dev flag can stand in for (main.ts).
const platform = process.argv.find((arg) => arg.startsWith("--brigadier-platform="))?.split("=")[1] ?? process.platform;

contextBridge.exposeInMainWorld("brigadier", {
  platform,
  trafficLights: (x: number) => ipcRenderer.send("traffic-lights", x),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  pickFolders: (options?: { at?: string; multi?: boolean }) => ipcRenderer.invoke("pick-folders", options),
  pickFile: (title: string, at?: string) => ipcRenderer.invoke("pick-file", { title, at }),
  onMenu: (listener: (command: string, paths?: string[]) => void) => {
    const heard = (_event: unknown, command: string, paths?: string[]) => listener(command, paths);
    ipcRenderer.on("menu", heard);
    return () => void ipcRenderer.off("menu", heard);
  },
  onScroll: (listener: (news: "mouse" | "lift" | "end") => void) => {
    const heard = (_event: unknown, news: "mouse" | "lift" | "end") => listener(news);
    ipcRenderer.on("scroll", heard);
    return () => void ipcRenderer.off("scroll", heard);
  },
  closesTab: (on: boolean) => ipcRenderer.send("closes-tab", on),
  ignoreMenuKeys: (on: boolean) => ipcRenderer.send("ignore-menu-keys", on),
  openLink: (url: string) => ipcRenderer.send("open-link", url),
  saveAttachment: (at: string, name: string): Promise<boolean> => ipcRenderer.invoke("save-attachment", at, name),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  notify: (notice: { title: string; body: string; silent: boolean; session?: string }) => ipcRenderer.invoke("notify", notice),
  badge: (count: number) => ipcRenderer.send("badge", count),
  running: (sessions: { id: string; title: string }[]) => ipcRenderer.send("running", sessions),
  /** The session using the computer now, and the chat it's in, for the menu bar item [D957]. */
  usingComputer: (using: { id: string; chat: string; title: string } | null) => ipcRenderer.send("using-computer", using),
  /** The menu bar item's Stop, for the session using the computer. */
  onComputerStop: (heard: (id: string) => void) => {
    const listener = (_event: unknown, id: string) => heard(id);
    ipcRenderer.on("computer-stop", listener);
    return () => void ipcRenderer.off("computer-stop", listener);
  },
  onNoticeClick: (listener: (session: string) => void) => {
    const heard = (_event: unknown, session: string) => listener(session);
    ipcRenderer.on("notice-click", heard);
    return () => void ipcRenderer.off("notice-click", heard);
  },
  notificationState: () => ipcRenderer.invoke("notification-state"),
  openNotificationSettings: () => ipcRenderer.send("open-notification-settings"),
  openPrivacySettings: (pane: "accessibility" | "screenRecording") => ipcRenderer.send("open-privacy-settings", pane),
  introBegin: () => ipcRenderer.invoke("intro-begin"),
  introShaped: () => ipcRenderer.invoke("intro-shaped"),
  introFinish: (fadeMs: number) => ipcRenderer.invoke("intro-finish", fadeMs),
  introRelease: () => ipcRenderer.invoke("intro-release"),
  onIntroEnded: (listener: () => void) => {
    const heard = () => listener();
    ipcRenderer.on("intro-ended", heard);
    return () => void ipcRenderer.off("intro-ended", heard);
  },
});

// The browser's door, for the tabs' <webview> layer (app/ui/src/browser/layer.ts); main answers only the app's top frame.
contextBridge.exposeInMainWorld("brigadierShell", {
  profilePartition: (profileId: string) => ipcRenderer.invoke("brigadier:profile-partition", profileId),
  guestFavicon: (id: number, href: string) => ipcRenderer.invoke("brigadier:guest-favicon", id, href),
  onGuestPopup: (listener: (details: unknown) => void) => void ipcRenderer.on("brigadier:guest-popup", (_event, details) => listener(details)),
  onGuestPermission: (listener: (details: unknown) => void) => void ipcRenderer.on("brigadier:guest-permission", (_event, details) => listener(details)),
  onGuestPermissionRefused: (listener: (details: unknown) => void) => void ipcRenderer.on("brigadier:guest-permission-refused", (_event, details) => listener(details)),
  onGuestEscape: (listener: (details: unknown) => void) => void ipcRenderer.on("brigadier:guest-escape", (_event, details) => listener(details)),
  onGuestKey: (listener: () => void) => void ipcRenderer.on("brigadier:guest-key", () => listener()),
  onPageSwipe: (listener: (details: unknown) => void) => {
    const heard = (_event: unknown, details: unknown) => listener(details);
    ipcRenderer.on("brigadier:page-swipe", heard);
    return () => void ipcRenderer.off("brigadier:page-swipe", heard);
  },
  // A key a page gave up (main's browser/guestKeys.ts). ⌘W, ⌘[ and ⌘] are the menu's, which never saw the press: they go
  // on as its commands; the rest to the page as presses (browser/keys.ts).
  onGuestShortcut: (listener: (key: string) => void) => void ipcRenderer.on("brigadier:guest-shortcut", (event, key: string) => {
    const command = ({ close: "close-tab", back: "back", forward: "forward" } as Record<string, string>)[key];
    if (command) ipcRenderer.emit("menu", event, command);
    else listener(key);
  }),
  answerPermission: (request: number, answer: string) => ipcRenderer.invoke("brigadier:permission-answer", request, answer),
  openPermissionSettings: (device: string) => ipcRenderer.invoke("brigadier:permission-open-settings", device),
  devtools: (op: string, args: unknown) => ipcRenderer.invoke("brigadier:devtools", op, args),
  profiles: (op: string, args: unknown) => ipcRenderer.invoke("brigadier:profiles", op, args),
  browserImport: (op: string, args: unknown) => ipcRenderer.invoke("brigadier:browser-import", op, args),
  onLocalCert: (listener: (details: unknown) => void) => void ipcRenderer.on("brigadier:browser-local-cert", (_event, details) => listener(details)),
  onBrowserDates: (listener: (details: unknown) => void) => void ipcRenderer.on("brigadier:browser-dates", (_event, details) => listener(details)),
  agent: (call: unknown) => ipcRenderer.invoke("brigadier:agent", call),
  onGuestSignIn: (listener: (details: unknown) => void) => void ipcRenderer.on("brigadier:guest-sign-in", (_event, details) => listener(details)),
  onAgentEvent: (listener: (details: unknown) => void) => void ipcRenderer.on("brigadier:agent-event", (_event, details) => listener(details)),
});
