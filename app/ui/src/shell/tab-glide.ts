import { type RefObject, useLayoutEffect, useRef } from "react";

/** The house's key: it's no tab of the list. */
export const HOUSE = "@house";
/** --duration-session-tab, Chrome's tab motion. */
const GLIDE_MS = 200;
// The most one frame moves it on: a page drawing for longer (a project's page mounting) doesn't eat the glide whole.
const STEP_MS = 34;
// --ease-session-tab, near enough: a short ease out.
const ease = (t: number) => 1 - (1 - t) * (1 - t);

/**
 * On a switch the front tab's shape glides from the last front tab to the new one [D834 D856]: one shape (`ghost`),
 * placed before the first paint and then each frame between the two tabs as they are then, so it stays on them while
 * they grow, shrink or the row changes [D854]; the new tab's own shape shows once it lands. Each tab draws its own the
 * rest of the time, so nothing else ever follows a measured box [D847]. Read after every commit: a page on its way
 * may name a front it draws only a commit later.
 */
export function useTabGlide(bar: RefObject<HTMLElement | null>, ghost: RefObject<HTMLElement | null>, front: string): void {
  const last = useRef<{ key: string; tab: Element } | null>(null);
  // The glide under way: where it is, and how to stop it.
  const run = useRef<{ at: () => DOMRect; stop: () => void } | null>(null);
  useLayoutEffect(() => {
    const row = bar.current;
    const shape = ghost.current;
    const find = (key: string) => row?.querySelector(key === HOUSE ? "[data-home]" : `[data-tab-id="${CSS.escape(key)}"]:not([data-closing])`) ?? null;
    const to = find(front);
    if (!row || !shape || !to) return;
    const before = last.current;
    last.current = { key: front, tab: to };
    if (!before || before.key === front) return;
    // A glide cut short goes on from where it got to; the last front drawn again since is looked up afresh.
    const held = run.current?.at() ?? null;
    run.current?.stop();
    const from = held ? null : before.tab.isConnected ? before.tab : find(before.key);
    if (!(held || from) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let start = held ?? from!.getBoundingClientRect();
    let then = performance.now();
    let gone = 0;
    let frame = 0;
    const place = (now: number) => {
      gone += Math.min(now - then, STEP_MS);
      then = now;
      const t = ease(Math.min(gone / GLIDE_MS, 1));
      // A tab that went (its closing slide over) holds where it was last.
      if (from?.isConnected) start = from.getBoundingClientRect();
      const end = to.getBoundingClientRect();
      const origin = row.getBoundingClientRect();
      const left = start.left + (end.left - start.left) * t;
      const right = start.right + (end.right - start.right) * t;
      Object.assign(shape.dataset, { x: left - origin.left, y: end.top - origin.top, w: right - left, h: end.height });
      if (gone < GLIDE_MS && to.isConnected) frame = requestAnimationFrame(place);
      else stop();
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      shape.hidden = true;
      delete row.dataset.gliding;
      run.current = null;
    };
    run.current = { at: () => shape.getBoundingClientRect(), stop };
    shape.hidden = false;
    row.dataset.gliding = "";
    place(then);
  });
  useLayoutEffect(() => () => run.current?.stop(), []);
}
