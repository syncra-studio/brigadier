import { followLayout } from "./follow";
import { type BrowserBounds, setModal } from "./layer";

/**
 * A Browser tab's page lies beneath the app's own page (layer.ts). The app cuts a hole in itself where each
 * page shows, so the page shows through, while its menus, tooltips, popovers and dialogs, which render at the
 * end of the body outside the cut app, draw above the live page. Clicks in a hole reach its page, unless a
 * menu, popover or dialog is open, which takes every click over a page (a click beside a menu closes it).
 */

/** App layers that take every click over a page while they are open. */
const MODAL = "[role=dialog], [role=alertdialog], [role=menu], [role=listbox]";

/** A popover that leaves the page live around it, taking clicks only on itself. */
const ABOVE = "[data-above-page]";

/** Where each tab's page shows now, by tab. */
const holes = new Map<string, BrowserBounds>();
let stopFollowing: (() => void) | null = null;
let cut = "";
let sent: boolean | null = null;
/** The cut's shape: the theme clips #root to it while a page shows (theme.css's data-page-beneath). */
let shape: SVGPathElement | null = null;

/**
 * Whether an open layer of the app takes clicks: any menu, popover or dialog, not one above the page
 * (`data-above-page`, such as a page's question for the camera).
 */
export function modalOpen(layers: Iterable<Element>): boolean {
  for (const layer of layers) {
    if (layer.matches(ABOVE) || layer.querySelector(ABOVE) || layer.closest(ABOVE)) continue;
    return true;
  }
  return false;
}

/**
 * The app's clip: the whole window but the holes, as a path whose window runs one way and each
 * hole the other, so a hole is cut however the holes overlap. A hole's bottom corner on the page
 * surface's own corner follows its curve, so the app's corner caps stay and the page sits in the
 * surface instead of poking out square.
 */
export function clipPath(
  width: number,
  height: number,
  cuts: Iterable<BrowserBounds>,
  surface?: { left: number; right: number; bottom: number; radius: number },
): string {
  let path = `M0 0H${width}V${height}H0Z`;
  for (const { x, y, width: w, height: h } of cuts) {
    const bottom = y + h;
    const right = x + w;
    const onBottom = surface !== undefined && Math.abs(bottom - surface.bottom) < 1;
    const r = surface?.radius ?? 0;
    const roundStart = onBottom && Math.abs(x - surface.left) < 1;
    const roundEnd = onBottom && Math.abs(right - surface.right) < 1;
    path += `M${x} ${y}`;
    path += roundStart ? `V${bottom - r}A${r} ${r} 0 0 0 ${x + r} ${bottom}` : `V${bottom}`;
    path += roundEnd ? `H${right - r}A${r} ${r} 0 0 0 ${right} ${bottom - r}` : `H${right}`;
    path += `V${y}Z`;
  }
  return path;
}

/** The page surface's edges and corner radius, read from the surface itself. */
function surfaceEdges() {
  const element = document.querySelector("[data-slot=page-surface]");
  if (!element) return undefined;
  const { left, right, bottom } = element.getBoundingClientRect();
  return { left, right, bottom, radius: parseFloat(getComputedStyle(element).borderBottomRightRadius) };
}

/** An SVG clip, since the theme can't take a path from an attribute; nonzero is its default rule. */
function makeShape(): SVGPathElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "brigadier-hole-svg";
  svg.setAttribute("aria-hidden", "true");
  const clip = document.createElementNS("http://www.w3.org/2000/svg", "clipPath");
  clip.id = "brigadier-hole";
  clip.setAttribute("clipPathUnits", "userSpaceOnUse");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  clip.append(path);
  svg.append(clip);
  document.body.append(svg);
  return path;
}

function sync() {
  const shown = holes.size > 0;
  const clip = shown ? clipPath(window.innerWidth, window.innerHeight, holes.values(), surfaceEdges()) : "";
  if (clip !== cut) {
    cut = clip;
    shape ??= makeShape();
    shape.setAttribute("d", clip);
    document.documentElement.toggleAttribute("data-page-beneath", shown);
  }
  const modal = shown && modalOpen(document.querySelectorAll(MODAL));
  if (modal !== sent) {
    sent = modal;
    setModal(modal);
  }
}

/** The tab's page shows at `bounds` (in the window), or no longer shows (`null`). */
export function showPage(id: string, bounds: BrowserBounds | null) {
  if (bounds) holes.set(id, bounds);
  else holes.delete(id);
  // Same frame as the page's own move. Menus open and floating controls move between placements,
  // and the window resizes: heard for as long as a page shows.
  sync();
  if (holes.size > 0) stopFollowing ??= followLayout(() => [document.documentElement], sync);
  else {
    stopFollowing?.();
    stopFollowing = null;
  }
}
