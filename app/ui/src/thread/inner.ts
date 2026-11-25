/** Between the event's target and the scroller, a box that still scrolls up, or keeps its scrolling to itself. */
export function inner(event: Event, el: HTMLElement): boolean {
  for (const node of event.composedPath()) {
    if (node === el) break;
    if (!(node instanceof HTMLElement)) continue;
    const style = getComputedStyle(node);
    const scrolls = style.overflowY === "auto" || style.overflowY === "scroll";
    if ((scrolls && node.scrollTop > 0) || ((scrolls || style.overflowY === "hidden") && (style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none"))) return true;
  }
  return false;
}

/** What the user means by a key or a touch: up from the end, or back to it. */
export type Way = "away" | "toward";

/** Which way a key scrolls the thread; none while it types or presses a button. */
export function keyWay(event: KeyboardEvent, el: HTMLElement): Way | null {
  const target = event.target;
  const space = event.key === " " || event.key === "Spacebar";
  if (target instanceof HTMLElement && target !== el && (target.isContentEditable || target.closest("input, select, textarea") || (space && target.closest('button, [role="button"]')))) return null;
  return ["ArrowUp", "Home", "PageUp"].includes(event.key) ? "away" : ["ArrowDown", "End", "PageDown"].includes(event.key) ? "toward" : space ? (event.shiftKey ? "away" : "toward") : null;
}

/** A touch moves this far before it says which way. */
const TOUCH_SLOP = 8;

/** A touch's handlers: `intend` hears which way it goes, once. */
export function touches(intend: (way: Way) => void) {
  let touch: { id: number; x: number; y: number } | null = null;
  return {
    start: (event: TouchEvent) => {
      const one = event.touches.length === 1 ? event.touches[0]! : null;
      touch = one && { id: one.identifier, x: one.clientX, y: one.clientY };
    },
    move: (event: TouchEvent) => {
      const from = touch;
      const one = event.touches.length === 1 ? event.touches[0]! : null;
      if (!from || !one || one.identifier !== from.id) return void (touch = null);
      const x = one.clientX - from.x;
      const y = one.clientY - from.y;
      if (Math.max(Math.abs(x), Math.abs(y)) < TOUCH_SLOP) return;
      touch = null;
      if (Math.abs(y) > Math.abs(x)) intend(y > 0 ? "away" : "toward");
    },
    end: () => void (touch = null),
  };
}
