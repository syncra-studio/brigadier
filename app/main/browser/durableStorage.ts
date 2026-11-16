// What a page writes must outlive a crash, and Chromium holds it back: a localStorage write waits about 5 s to
// commit, and longer for a site that writes often. So the kept-alive state is committed on the moments that
// matter (a page leaving) and on a short beat for the rest, which a commit with nothing pending makes free.
// A kill -9 can still lose what was written in the last FLUSH_EVERY_MS without a navigation.
import type { Session, WebContents } from "electron";

const FLUSH_EVERY_MS = 3000;
const FLUSH_SOON_MS = 150;

const sessions = new Set<Session>();
const soon = new WeakSet<Session>();

function flushSoon(session: Session): void {
  if (soon.has(session)) return;
  soon.add(session);
  setTimeout(() => {
    soon.delete(session);
    session.flushStorageData();
  }, FLUSH_SOON_MS);
}

export function installDurableStorage(): void {
  setInterval(() => {
    for (const session of sessions) session.flushStorageData();
  }, FLUSH_EVERY_MS);
}

/** Each page's storage goes on the beat, and at once when a guest leaves its page: sign-ins write and then go. */
export function keepStorageOf(contents: WebContents): void {
  sessions.add(contents.session);
  if (contents.getType() !== "webview") return;
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) flushSoon(contents.session);
  });
}
