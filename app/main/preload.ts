import { contextBridge, ipcRenderer } from "electron";

// A MessagePort can't cross contextBridge, so it reaches the page as a transfer.
ipcRenderer.on("daemon-port", (event) => {
  window.postMessage("daemon-port", window.location.origin, event.ports);
});

// The native folder picker, the one call the page makes to main (main.ts).
contextBridge.exposeInMainWorld("brigadier", { pickFolder: () => ipcRenderer.invoke("pick-folder") });
