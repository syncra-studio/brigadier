import { contextBridge, ipcRenderer } from "electron";

// A MessagePort can't cross contextBridge, so it reaches the page as a transfer.
ipcRenderer.on("daemon-port", (event) => {
  window.postMessage("daemon-port", window.location.origin, event.ports);
});

// What the page asks of main (main.ts): the native folder pickers, the menu's commands, and the intro's window staging (intro.ts).
contextBridge.exposeInMainWorld("brigadier", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  pickFolders: (options?: { at?: string; multi?: boolean }) => ipcRenderer.invoke("pick-folders", options),
  onMenu: (listener: (command: string, paths?: string[]) => void) => {
    const heard = (_event: unknown, command: string, paths?: string[]) => listener(command, paths);
    ipcRenderer.on("menu", heard);
    return () => void ipcRenderer.off("menu", heard);
  },
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
