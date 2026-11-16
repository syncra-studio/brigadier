// What shows over a tab an agent drives: its named cursor and the take-over shield. Drawn in the app, never in the
// page: the page can't see it, and a picture of the page doesn't have it.
//
// The shield is the only way the user's input is told from the agent's. Debugger input is trusted to the page and
// runs through the same paths as a real click, so nothing can tell them apart after the fact. A plain element above
// the page takes the user's first click or key, says so, and goes; the agent's input goes under it. The layer lies
// under #root like the pages, so the app's own menus stay above it, and it is a sibling of the tab layer so the
// page layer's children stay exactly the pages. Where each part shows is in data attributes the theme reads
// (theme.css's #brigadier-agent-layer), with the cursor's fixed colours: it lies over any site.
import type { BrowserBounds } from "./layer";

type Overlay = {
  frame: HTMLDivElement;
  cursor: HTMLDivElement | null;
  name: HTMLSpanElement | null;
  at: { x: number; y: number } | null;
  placed: BrowserBounds | null;
  shielded: boolean;
  onUsed: () => void;
  onWheel: (at: { x: number; y: number; deltaX: number; deltaY: number }) => void;
};

const overlays = new Map<string, Overlay>();
let layer: HTMLDivElement | null = null;

export function installAgentOverlays(): void {
  layer = document.createElement("div");
  layer.id = "brigadier-agent-layer";
  document.getElementById("brigadier-tab-layer")?.after(layer);
  // The keyboard can't reach a page under a shield by Tab or by anything else in the app: the shield takes it.
  document.addEventListener("focusin", (event) => {
    if (!(event.target instanceof HTMLElement) || event.target.tagName !== "WEBVIEW") return;
    const tab = event.target.dataset.tab;
    const overlay = tab ? overlays.get(tab) : undefined;
    if (overlay?.shielded) overlay.frame.focus({ preventScroll: true });
  });
}

/** Puts `element` at `x`, `y` of its parent. */
function at(element: HTMLElement, { x, y }: { x: number; y: number }): void {
  element.dataset.x = String(x);
  element.dataset.y = String(y);
}

function placeFrame({ frame, placed }: Overlay): void {
  frame.toggleAttribute("data-shown", placed !== null);
  if (!placed) return;
  frame.dataset.left = String(placed.x);
  frame.dataset.top = String(placed.y);
  frame.dataset.width = String(placed.width);
  frame.dataset.height = String(placed.height);
}

/** A driven tab's overlay: `onUsed` hears the user's first click or key, `onWheel` their scrolling. */
export function raiseShield(id: string, page: HTMLElement, bounds: BrowserBounds | null, onUsed: () => void, onWheel: Overlay["onWheel"]): void {
  let overlay = overlays.get(id);
  if (!overlay) {
    const frame = document.createElement("div");
    frame.className = "brigadier-agent-frame";
    frame.tabIndex = -1;
    frame.dataset.agentTab = id;
    overlay = { frame, cursor: null, name: null, at: null, placed: bounds, shielded: false, onUsed, onWheel };
    overlays.set(id, overlay);
    const own = overlay;
    const take = (event: Event) => {
      if (!own.shielded) return;
      event.preventDefault();
      event.stopPropagation();
      own.onUsed();
    };
    frame.addEventListener("pointerdown", take);
    frame.addEventListener("keydown", take);
    frame.addEventListener("wheel", (event) => {
      if (!own.shielded) return;
      const rect = frame.getBoundingClientRect();
      own.onWheel({ x: event.clientX - rect.left, y: event.clientY - rect.top, deltaX: event.deltaX, deltaY: event.deltaY });
    }, { passive: true });
    layer?.append(frame);
  }
  overlay.onUsed = onUsed;
  overlay.onWheel = onWheel;
  overlay.placed = bounds;
  placeFrame(overlay);
  overlay.shielded = true;
  overlay.frame.toggleAttribute("data-shielded", true);
  // The keyboard was in the page: its first key is the user's too, so the shield holds it from here.
  if (document.activeElement === page) overlay.frame.focus({ preventScroll: true });
}

/** The shield goes and the cursor with it: the tab is the user's now, or no one drives it. */
export function dropOverlay(id: string): void {
  const overlay = overlays.get(id);
  if (!overlay) return;
  overlay.frame.remove();
  overlays.delete(id);
}

export function placeOverlay(id: string, bounds: BrowserBounds | null): void {
  const overlay = overlays.get(id);
  if (!overlay) return;
  overlay.placed = bounds;
  placeFrame(overlay);
}

const stillMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const ARROW = `<svg width="20" height="22" viewBox="0 0 20 22" aria-hidden="true"><path d="M2 1.5 L2 17.5 L6.4 13.6 L9.3 20 L12.2 18.7 L9.4 12.4 L15.4 12.2 Z"/></svg>`;

function cursorOf(overlay: Overlay, label: string): HTMLDivElement {
  if (!overlay.cursor) {
    const cursor = document.createElement("div");
    cursor.className = "brigadier-agent-cursor";
    cursor.dataset.agentCursor = "";
    cursor.innerHTML = ARROW;
    const name = document.createElement("span");
    name.className = "brigadier-agent-name";
    cursor.append(name);
    overlay.frame.append(cursor);
    overlay.cursor = cursor;
    overlay.name = name;
  }
  if (overlay.name) overlay.name.textContent = label;
  return overlay.cursor;
}

const transformAt = ({ x, y }: { x: number; y: number }) => `translate(${x - 2}px, ${y - 1}px)`;

/**
 * The cursor glides to `to`, a point of the page, and this answers when it is there. Behind its tab the page shows
 * nothing, so nothing is waited for. Timed by the clock: a hidden window runs no animation to its end.
 */
export function glideTo(id: string, label: string, to: { x: number; y: number }): Promise<void> {
  const overlay = overlays.get(id);
  if (!overlay) return Promise.resolve();
  const cursor = cursorOf(overlay, label);
  const from = overlay.at ?? { x: (overlay.placed?.width ?? 0) / 2, y: (overlay.placed?.height ?? 0) * 0.15 };
  overlay.at = to;
  at(cursor, to);
  if (!overlay.placed) return Promise.resolve();
  if (stillMotion()) return Promise.resolve();
  // The same feel as the archive's agent_cursor: quick for a near control, unhurried across the page.
  const ms = Math.min(620, Math.max(220, 220 + Math.hypot(to.x - from.x, to.y - from.y) * 0.55));
  cursor.animate([{ transform: transformAt(from) }, { transform: transformAt(to) }], { duration: ms, easing: "cubic-bezier(0.22, 0.8, 0.24, 1)" });
  return new Promise((resolve) => setTimeout(resolve, ms + 40));
}

/** The press shows where the cursor is. */
export function pressAt(id: string): void {
  const overlay = overlays.get(id);
  if (!overlay?.at || !overlay.placed || stillMotion()) return;
  const ring = document.createElement("div");
  ring.className = "brigadier-agent-press";
  at(ring, overlay.at);
  overlay.frame.append(ring);
  ring.animate([{ transform: "scale(0.4)", opacity: 0.9 }, { transform: "scale(1.3)", opacity: 0 }], { duration: 320, easing: "ease-out" }).finished.finally(() => ring.remove());
}
