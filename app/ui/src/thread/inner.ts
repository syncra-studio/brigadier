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
