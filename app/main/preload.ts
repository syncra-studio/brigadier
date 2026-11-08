import { contextBridge, ipcRenderer } from "electron";

// A MessagePort can't cross contextBridge, so it reaches the page as a transfer.
ipcRenderer.on("daemon-port", (event) => {
  window.postMessage("daemon-port", window.location.origin, event.ports);
});

// What the page asks of main (main.ts): the native folder picker, and the intro's window staging (intro.ts).
contextBridge.exposeInMainWorld("brigadier", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
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
