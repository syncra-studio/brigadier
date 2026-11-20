// Swiping Back and Forward over a tab's page walks the page's own history, as in browsers [D3110]. The page's wheel
// events never reach the app, so a listener in an isolated world of the page tallies the swipe, read here while the
// trackpad's scroll lasts and sent to the app, which draws the chip and goes Back or Forward (shell/titlebar.tsx).
import type { WebContents } from "electron";

import { watchScrolls } from "../scrolls";

const SWIPE_WORLD = 1011;
const READ_MS = 33;

// The app's own rules (titlebar.tsx), plus the page itself scrolling sideways. Isolated: the page can't see or forge it.
// shortcut: wheels inside an iframe don't reach the top page, so a swipe over one is the iframe's; tally frames too if that matters.
const TALLY = `(() => {
  if (window.__swipe) return;
  const swipe = (window.__swipe = { dx: 0, events: 0, at: 0, ours: null });
  const scrollsSideways = (from, dx) => {
    for (let at = from instanceof Element ? from : null; at; at = at.parentElement) {
      const overflowX = getComputedStyle(at).overflowX;
      const scroller = overflowX === "auto" || overflowX === "scroll" || (at === document.scrollingElement && overflowX !== "hidden" && overflowX !== "clip");
      if (scroller && (dx < 0 ? at.scrollLeft > 0 : at.scrollLeft + at.clientWidth < at.scrollWidth - 1)) return true;
    }
    return false;
  };
  addEventListener("wheel", (event) => {
    if (swipe.ours !== null && event.timeStamp - swipe.at > 500) swipe.ours = null;
    if (swipe.ours === null) Object.assign(swipe, { dx: 0, events: 0, ours: Math.abs(event.deltaX) > Math.abs(event.deltaY) && !event.defaultPrevented && !scrollsSideways(event.target, event.deltaX) });
    swipe.at = event.timeStamp;
    if (!swipe.ours) return;
    swipe.dx += event.deltaX;
    swipe.events += 1;
  }, { passive: true });
})()`;
const read = (end: boolean) => `(() => {
  const swipe = window.__swipe;
  const now = swipe && swipe.ours ? { dx: swipe.dx, events: swipe.events } : null;
  if (swipe && ${end}) swipe.ours = null;
  return now;
})()`;

/** A tab's page: its trackpad swipes go to the app as `brigadier:page-swipe`, read while the fingers are down and once
 * as they lift (or at the scroll's end, without the addon's lift). A mouse's scroll and momentum are only cleared. */
export function installGuestSwipe(guest: WebContents): void {
  guest.on("dom-ready", () => void guest.executeJavaScriptInIsolatedWorld(SWIPE_WORLD, [{ code: TALLY }]).catch(() => {}));
  let reading: NodeJS.Timeout | undefined;
  // The app while a swipe lasts: a page that goes mid-swipe tells it the end, so its chip never stays.
  let host: WebContents | null = null;
  const from = guest.id;
  const send = (end: boolean) => {
    const to = host;
    void guest.executeJavaScriptInIsolatedWorld(SWIPE_WORLD, [{ code: read(end) }]).then((now: { dx: number; events: number } | null) => {
      if (now && to && !to.isDestroyed() && !guest.isDestroyed()) to.send("brigadier:page-swipe", { from, ...now, end });
    }, () => {});
  };
  const ended = () => {
    clearInterval(reading);
    send(true);
    host = null;
  };
  watchScrolls(guest, {
    begin: (trackpad) => {
      clearInterval(reading);
      host = trackpad ? guest.hostWebContents : null;
      if (host) reading = setInterval(() => send(false), READ_MS);
    },
    lift: ended,
    // After a lift, or a mouse's scroll, this only clears the tally: nothing goes to the app.
    end: ended,
  });
  guest.once("destroyed", () => {
    clearInterval(reading);
    if (host && !host.isDestroyed()) host.send("brigadier:page-swipe", { from, dx: 0, events: 0, end: true });
  });
}
