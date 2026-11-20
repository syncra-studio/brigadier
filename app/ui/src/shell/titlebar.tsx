import { useEffect, useState } from "react";

import { guestPage } from "../browser/layer";
import { TooltipIconButton } from "../components/icon-button";
import { useSidebar } from "../components/sidebar";
import { TitlebarTips } from "../components/tooltip";
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Minus, Sidebar, SidebarFloatingLeft, X } from "../icons";
import { store } from "../onboarding/api";
import { settingsOrigin, settingsPageOf } from "../settings/shell";
import { keysOf, matches } from "../shortcuts";
import type { SessionRow } from "../sidebar/words";

// The old app's history (state/history.ts) [kit D170]: Back goes by where you are, never by how you got there, a
// session to Home, and Home has nowhere to go. Forward redoes what Back left; any other navigation clears it.
const ahead = store<string | null>(null);
// Settings walks its own pages since it opened, Back off the first leaving it [D927].
const walk = store<{ pages: string[]; at: number }>({ pages: [], at: 0 });
let stepping: string | null = null;
window.addEventListener("hashchange", (event) => {
  const hash = window.location.hash;
  const ours = hash === stepping;
  stepping = null;
  if (ours) return;
  ahead.set(null);
  if (settingsPageOf(hash) === null) return;
  const { pages, at } = walk.get();
  const inside = settingsPageOf(new URL(event.oldURL).hash) !== null;
  walk.set(inside ? { pages: [...pages.slice(0, at + 1), hash], at: at + 1 } : { pages: [hash], at: 0 });
});

const MOUSE_BACK = 3;
const MOUSE_FORWARD = 4;
// An empty listbox is no menu: a note's editor keeps one, Lexical's typeahead anchor, while its / menu is shut [D291].
export const blocked = () => document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]:not(:empty)') !== null;

// A two-finger swipe's travel (wheel deltaX) that arms Back or Forward [D3110].
const SWIPE_ARM = 120;
// A wheel this long after the last starts a new swipe: one whose scroll never ends (a page took its wheel) is dropped.
const SWIPE_STALE_MS = 500;
// The swipe now, from its first wheel event to main's scroll-end after the fingers lift and any momentum. It isn't
// ours when it starts mostly vertical, over a dialog or an agent's page, or where something takes or scrolls it.
let swiping: { dx: number; events: number; at: number; ours: boolean } | null = null;
/** Whether something under the pointer scrolls sideways itself towards `dx`'s side: a code block, a table, the tab strip, the board. */
function scrollsSideways(from: EventTarget | null, dx: number): boolean {
  for (let at = from instanceof Element ? from : null; at; at = at.parentElement) {
    const { overflowX } = getComputedStyle(at);
    if ((overflowX === "auto" || overflowX === "scroll") && (dx < 0 ? at.scrollLeft > 0 : at.scrollLeft + at.clientWidth < at.scrollWidth - 1)) return true;
  }
  return false;
}

/** The traffic lights' x on the tab bar's row, the same in every sidebar mode [D48]. The real lights are 60px wide, not the board's 52. */
const LIGHTS_X = 13;

/**
 * Back and Forward by their buttons, keys, mouse buttons and menu items, the same pair in the app and Settings, each walking
 * its own history, then a rule and the sidebar toggle, after the traffic lights in every sidebar mode (titlebar-nav)
 * [D926 D933 D934]. The toggle steps open, strip, hidden, and open again [D654 D800].
 */
export function TitlebarNav({ hash, rows }: { hash: string; rows: SessionRow[] | undefined }) {
  const { open, collapse, toggleSidebar, canToggle } = useSidebar();
  const mode = open ? "open" : collapse === "hidden" ? "hidden" : "strip";
  useEffect(() => window.brigadier?.trafficLights?.(LIGHTS_X), []);
  const page = settingsPageOf(hash);
  const { pages, at } = walk.use();
  const later = ahead.use();
  const inSettings = page !== null;
  const forward = inSettings ? (pages[at + 1] ?? null) : later;
  const up = inSettings ? (at > 0 ? pages[at - 1]! : settingsOrigin()) : hash.startsWith("#thread/") || hash.startsWith("#project/") ? "" : null;
  // A session deleted since shows Home instead.
  const go = (place: string) => {
    const gone = place.startsWith("#thread/") && rows && !rows.some((row) => row.id === decodeURIComponent(place.slice("#thread/".length)));
    stepping = gone ? "" : place;
    window.location.hash = stepping;
  };
  const stepBack = () => {
    if (up === null) return;
    if (inSettings && at > 0) walk.set({ pages, at: at - 1 });
    else ahead.set(hash);
    go(up);
  };
  const stepForward = () => {
    if (forward === null) return;
    if (inSettings) walk.set({ pages, at: at + 1 });
    else ahead.set(null);
    go(forward);
  };
  const step = (delta: -1 | 1) => {
    if (!blocked()) (delta === -1 ? stepBack : stepForward)();
  };
  // Swiping's chip at the window's edge: it follows the fingers in and brightens once armed; nowhere to go, none [D3110].
  const [chip, setChip] = useState<{ side: -1 | 1; travel: number; gone?: "went" | "short" } | null>(null);
  const gone = chip?.gone;
  useEffect(() => {
    if (!gone) return;
    const timer = setTimeout(() => setChip((now) => (now?.gone ? null : now)), 250);
    return () => clearTimeout(timer);
  }, [gone]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const delta = matches(event, "back") ? -1 : matches(event, "forward") ? 1 : 0;
      if (event.defaultPrevented || delta === 0) return;
      event.preventDefault();
      step(delta);
    };
    const onMouse = (event: MouseEvent) => {
      if (event.button !== MOUSE_BACK && event.button !== MOUSE_FORWARD) return;
      event.preventDefault();
      if (event.type === "mouseup") step(event.button === MOUSE_BACK ? -1 : 1);
    };
    const offMenu = window.brigadier?.onMenu((command) => {
      if (command === "toggle-sidebar") toggleSidebar();
      if (command === "back") step(-1);
      if (command === "forward") step(1);
    });
    // Back with the fingers moving right, Forward moving left, as in browsers: the app's or Settings' own step, as the arrows' [D3110 D926 D927],
    // or over a tab's page that page's history. The chip shows only where there's somewhere to go.
    type Walk = { can: (side: -1 | 1) => boolean; go: (side: -1 | 1) => void };
    const app: Walk = { can: (side) => (side < 0 ? up : forward) !== null, go: step };
    const swiped = (walk: Walk, dx: number, events: number, end: boolean) => {
      const side = dx < 0 ? -1 : 1;
      // A mouse's notch is one wheel event, its own scroll, never a swipe.
      const swipe = events > 1;
      if (!end) return setChip(swipe && walk.can(side) ? { side, travel: Math.min(Math.abs(dx) / SWIPE_ARM, 1) } : null);
      const went = swipe && Math.abs(dx) >= SWIPE_ARM && walk.can(side);
      if (went) walk.go(side);
      setChip((now) => now && { ...now, gone: went ? "went" : "short" });
    };
    const onWheel = (event: WheelEvent) => {
      if (swiping && event.timeStamp - swiping.at > SWIPE_STALE_MS) swiping = null;
      const target = event.target instanceof Element ? event.target : null;
      swiping ??= { dx: 0, events: 0, at: 0, ours: Math.abs(event.deltaX) > Math.abs(event.deltaY) && !event.defaultPrevented && !blocked() && !target?.closest(".brigadier-agent-frame") && !scrollsSideways(target, event.deltaX) };
      swiping.at = event.timeStamp;
      if (!swiping.ours) return;
      swiping.dx += event.deltaX;
      swiping.events += 1;
      swiped(app, swiping.dx, swiping.events, false);
    };
    const offEnd = window.brigadier?.onScrollEnd(() => {
      const ended = swiping;
      swiping = null;
      if (ended?.ours) swiped(app, ended.dx, ended.events, true);
    });
    const offPage = window.brigadierShell?.onPageSwipe(({ from, dx, events, end }) => {
      const page = guestPage(from);
      if (page) swiped({ can: (side) => (side < 0 ? page.canGoBack() : page.canGoForward()), go: (side) => (side < 0 ? page.goBack() : page.goForward()) }, dx, events, end);
    });
    addEventListener("keydown", onKeyDown);
    addEventListener("mousedown", onMouse);
    addEventListener("mouseup", onMouse);
    addEventListener("wheel", onWheel, { passive: true });
    return () => {
      offMenu?.();
      offEnd?.();
      offPage?.();
      removeEventListener("wheel", onWheel);
      removeEventListener("keydown", onKeyDown);
      removeEventListener("mousedown", onMouse);
      removeEventListener("mouseup", onMouse);
    };
  });
  // Back, Forward, a rule, then the toggle; Settings holds the panel open, so it has no toggle [D34 D926].
  return (
    <>
      {chip && (
        <div aria-hidden className="swipe-chip" data-side={chip.side < 0 ? "back" : "forward"} data-travel={chip.travel} data-armed={chip.travel === 1 || undefined} data-gone={chip.gone}>
          {chip.side < 0 ? <ChevronLeft /> : <ChevronRight />}
        </div>
      )}
      <div className="titlebar-nav app-no-drag fixed z-20 flex items-center gap-0.5">
        <TitlebarTips>
          <TooltipIconButton look="strip" tooltip="Back" shortcut={keysOf("back")[0]} disabled={up === null} onClick={() => step(-1)}>
            <ArrowLeft />
          </TooltipIconButton>
          <TooltipIconButton look="strip" tooltip="Forward" shortcut={keysOf("forward")[0]} disabled={forward === null} onClick={() => step(1)}>
            <ArrowRight />
          </TooltipIconButton>
          {canToggle && (
            <>
              <span aria-hidden className="titlebar-nav-rule" />
              {/* Its name says what a click does; aria-expanded would draw an open fill. */}
              <TooltipIconButton look="strip" tip={false} tooltip={{ open: "Collapse sidebar", strip: "Hide sidebar", hidden: "Show sidebar" }[mode]} data-slot="sidebar-toggle" onClick={toggleSidebar}>
                {open ? <Sidebar /> : <SidebarFloatingLeft />}
              </TooltipIconButton>
            </>
          )}
        </TitlebarTips>
      </div>
    </>
  );
}

/**
 * Dev only: the Windows layout drawn on a Mac (BRIGADIER_FAKE_PLATFORM=win32) gets stand-ins for the caption buttons
 * Windows draws over its titlebar overlay, the board's three 46×56 at the window's end.
 */
export function FakeCaption() {
  if (window.brigadier?.platform !== "win32" || !/Mac/.test(navigator.platform)) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed end-0 top-0 z-50 flex h-tab-bar text-foreground">
      {[<Minus key="min" />, <span key="max" className="size-3 rounded-xs ring-1 ring-current" />, <X key="close" />].map((glyph) => (
        <span key={glyph.key} className="flex w-11.5 items-center justify-center svg:size-icon-sm">{glyph}</span>
      ))}
    </div>
  );
}
