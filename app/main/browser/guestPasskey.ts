// Every frame of every guest and popup on macOS (browserHost.ts lets it into subframes), until Apple grants the browser passkey entitlement (section 7). Stock Electron
// serves no passkey request and never answers one, so a page waits forever. So pages see a browser without passkeys
// and offer their other ways first: Google, told it has none, asks for the password instead of failing its passkey
// step. A request made anyway fails at once; passkey autofill (`conditional`) shows nothing.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.executeInMainWorld({
  func: (refused: () => void) => {
    delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    const credentials = navigator.credentials;
    if (!credentials) return;
    for (const name of ["get", "create"] as const) {
      const real = credentials[name].bind(credentials);
      credentials[name] = (options?: CredentialRequestOptions & CredentialCreationOptions) => {
        if (!options?.publicKey || options.mediation === "conditional") return real(options);
        refused();
        return Promise.reject(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
      };
    }
  },
  args: [() => ipcRenderer.send("brigadier:guest-passkey-refused")],
});
