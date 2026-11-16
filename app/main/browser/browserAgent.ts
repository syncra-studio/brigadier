// The agent's hold on a tab's page (section 3). For now only what DevTools needs: which tabs have it open, and
// telling the app's page, which pauses an agent's tab on it (pause.ts).
// shortcut: no debugger hold, input or activity until the agent verbs land; then the old held/attach/release/acting come here, release() goes back into watchDevTools, and beforeDevTools with them.
import type { WebContents } from "electron";

/** Tabs with DevTools open. `isDevToolsOpened` answers false for DevTools in a view of ours (browserDevtools.ts). */
const opened = new Set<number>();
export const devToolsOpen = (guest: WebContents): boolean => opened.has(guest.id) || guest.isDevToolsOpened();

function tellHost(guest: WebContents, event: "devtools-opened" | "devtools-closed" | "detached"): void {
  guest.hostWebContents?.send("brigadier:agent-event", { from: guest.id, event });
}

/** DevTools ends a debugger session (electron.d.ts, Debugger's `detach`), so opening it counts as take-over. */
function watchDevTools(guest: WebContents): void {
  guest.on("devtools-opened", () => {
    opened.add(guest.id);
    tellHost(guest, "devtools-opened");
  });
  guest.on("devtools-closed", () => devToolsEnded(guest));
}

/** DevTools went from this tab. Closing DevTools held in a view of ours fires no `devtools-closed`, so its view's end says so. */
export function devToolsEnded(guest: WebContents): void {
  opened.delete(guest.id);
  if (!guest.isDestroyed()) tellHost(guest, "devtools-closed");
}

/** Every tab's guest, from when it is made. */
export function watchGuest(guest: WebContents): void {
  const id = guest.id;
  watchDevTools(guest);
  guest.once("destroyed", () => opened.delete(id));
}
