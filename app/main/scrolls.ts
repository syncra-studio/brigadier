// A trackpad scroll's start, lift and end, for swiping Back and Forward in the app and on a tab's page [D3110].
// Electron's input-event gives the scroll's start and end (the end after any momentum); the panel addon's monitor
// (crates/panel) tells whether it is a trackpad's and when the fingers lift. Without the addon (other systems, or its
// first moments) every scroll counts as a trackpad's and ends at its end.
import type { WebContents } from "electron";

export type ScrollAddon = { trackpadScroll?: () => boolean; scrollLifts?: () => number };
let addon: ScrollAddon = {};
export const useScrollAddon = (loaded: ScrollAddon) => void (addon = loaded);

const LIFT_POLL_MS = 16;

/** `begin` as a scroll starts, `lift` as its fingers lift (before any momentum), `end` as it ends, lifted or not. */
export function watchScrolls(contents: WebContents, on: { begin(trackpad: boolean): void; lift(): void; end(lifted: boolean): void }): void {
  let polling: NodeJS.Timeout | undefined;
  let before: number | undefined;
  let lifted = false;
  // Asked on the poll and on each input event, which runs before Chromium passes the event on: momentum's first
  // wheel comes after the lift's news, so it never counts towards the swipe.
  const liftedYet = () => {
    if (lifted || before === undefined || addon.scrollLifts?.() === before) return;
    clearInterval(polling);
    lifted = true;
    on.lift();
  };
  contents.on("input-event", (_event, input) => {
    if (input.type === "gestureScrollBegin") {
      clearInterval(polling);
      lifted = false;
      on.begin(addon.trackpadScroll?.() ?? true);
      before = addon.scrollLifts?.();
      if (before !== undefined) polling = setInterval(liftedYet, LIFT_POLL_MS);
    } else if (input.type === "gestureScrollEnd") {
      clearInterval(polling);
      before = undefined;
      on.end(lifted);
    } else liftedYet();
  });
  contents.once("destroyed", () => clearInterval(polling));
}
