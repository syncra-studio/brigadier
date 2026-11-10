import { contextBridge, ipcRenderer } from "electron";

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

// What the page asks of main (main.ts): the native folder pickers, the menu's commands, and the intro's window staging (intro.ts).
ipcRenderer.on("full-screen", (_event, on: boolean) => document.documentElement.toggleAttribute("data-fullscreen", on));

contextBridge.exposeInMainWorld("brigadier", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  pickFolders: (options?: { at?: string; multi?: boolean }) => ipcRenderer.invoke("pick-folders", options),
  onMenu: (listener: (command: string, paths?: string[]) => void) => {
    const heard = (_event: unknown, command: string, paths?: string[]) => listener(command, paths);
    ipcRenderer.on("menu", heard);
    return () => void ipcRenderer.off("menu", heard);
  },
  closesTab: (on: boolean) => ipcRenderer.send("closes-tab", on),
  openLink: (url: string) => ipcRenderer.send("open-link", url),
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
