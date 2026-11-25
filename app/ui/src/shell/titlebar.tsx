import { useEffect, useState } from "react";

import { guestPage } from "../browser/layer";
import { TooltipIconButton } from "../components/icon-button";
import { useSidebar } from "../components/sidebar";
import { TitlebarTips } from "../components/tooltip";
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, MagnifyingGlassSearch, Minus, Sidebar, SidebarFloatingLeft, X } from "../icons";
import { store } from "../onboarding/api";
import { openSearch } from "../palette/palette";
import { prPageOf } from "../pull-requests/route";
import { settingsPageOf } from "../settings/shell";
import { keysOf, matches } from "../shortcuts";
import type { SessionRow } from "../sidebar/words";

// The old app's history (state/history.ts) [kit D170]: Back goes by where you are, never by how you got there, a
// session to Home, and Home has nowhere to go. Forward redoes what Back left; any other navigation clears it.
const ahead = store<string | null>(null);
// Settings and Pull Requests, each with its own sidebar, walk their own pages since they opened, Back off the first going
// where they were opened from [D927 D296].
type Section = "settings" | "prs";
type Trail = { pages: string[]; at: number; from: string };
const sectionOf = (hash: string): Section | null => (settingsPageOf(hash) !== null ? "settings" : prPageOf(hash) !== null ? "prs" : null);
const walks = store<Partial<Record<Section, Trail>>>({});
const setWalk = (section: Section, walk: Trail) => walks.set({ ...walks.get(), [section]: walk });
let stepping: string | null = null;
window.addEventListener("hashchange", (event) => {
  const hash = window.location.hash;
  const ours = hash === stepping;
  stepping = null;
  if (ours) return;
  ahead.set(null);
  const section = sectionOf(hash);
  if (section === null) return;
  const from = new URL(event.oldURL).hash;
  const now = walks.get()[section];
  setWalk(section, now && sectionOf(from) === section ? { ...now, pages: [...now.pages.slice(0, now.at + 1), hash], at: now.at + 1 } : { pages: [hash], at: 0, from });
});

const MOUSE_BACK = 3;
const MOUSE_FORWARD = 4;
// An empty listbox is no menu: a note's editor keeps one, Lexical's typeahead anchor, while its / menu is shut [D291].
export const blocked = () => document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]:not(:empty)') !== null;

// A two-finger swipe's travel (wheel deltaX) that arms Back or Forward [D3110].
const SWIPE_ARM = 120;
// A wheel this long after the last starts a new swipe: one whose scroll never ends (a page took its wheel) is dropped.
const SWIPE_STALE_MS = 500;
// The swipe now, from its first wheel event to the fingers' lift (main's scroll news), or to the scroll's end where
// the lift isn't known; momentum after a lift and a mouse's scroll are spent, never a swipe. It isn't ours when it
// starts mostly vertical, over a dialog, an agent's page or the tab bar (its wheel scrolls the strip from anywhere on
// it), or where something takes or scrolls it.
let swiping: { dx: number; events: number; at: number; ours: boolean } | null = null;
/** Whether something under the pointer scrolls sideways itself towards `dx`'s side: a code block, a table, the tab strip, the board. */
function scrollsSideways(from: EventTarget | null, dx: number): boolean {
  for (let at = from instanceof Element ? from : null; at; at = at.parentElement) {
    const { overflowX } = getComputedStyle(at);
    if ((overflowX === "auto" || overflowX === "scroll") && (dx < 0 ? at.scrollLeft > 0 : at.scrollLeft + at.clientWidth < at.scrollWidth - 1)) return true;
  }
  return false;
}

/** The traffic lights' x on the titlebar row, the same in every sidebar mode [D34 D48]. */
const LIGHTS_X = 16;

/**
 * Back and Forward right after the traffic lights by their buttons, keys, mouse buttons and menu items, then the sidebar
 * toggle, on every page with the sidebar shown or hidden, and Search after them while it's hidden; the pair walks the
 * app's, Settings' or Pull Requests' own history [D926 D265 D296 D297]. The toggle shows or hides the sidebar [D67].
 */
export function TitlebarNav({ hash, rows }: { hash: string; rows: SessionRow[] | undefined }) {
  const { open, toggleSidebar } = useSidebar();
  useEffect(() => window.brigadier?.trafficLights?.(LIGHTS_X), []);
  const section = sectionOf(hash);
  const all = walks.use();
  const walk = section ? all[section] : undefined;
  const later = ahead.use();
  // A section's next page, else what Back left; opened at launch, it has no walk and Back goes to New chat.
  const next = walk?.pages[walk.at + 1];
  const forward = next ?? later;
  const up = section ? (walk && walk.at > 0 ? walk.pages[walk.at - 1]! : (walk?.from ?? "")) : hash.startsWith("#thread/") ? "" : null;
  // A session deleted since shows Home instead.
  const go = (place: string) => {
    const gone = place.startsWith("#thread/") && rows && !rows.some((row) => row.id === decodeURIComponent(place.slice("#thread/".length)));
    stepping = gone ? "" : place;
    window.location.hash = stepping;
  };
  const stepBack = () => {
    if (up === null) return;
    if (section && walk && walk.at > 0) setWalk(section, { ...walk, at: walk.at - 1 });
    else ahead.set(hash);
    go(up);
  };
  const stepForward = () => {
    if (forward === null) return;
    if (section && walk && next) setWalk(section, { ...walk, at: walk.at + 1 });
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
      // A lone wheel after the end (main's end can beat the gesture's last wheel here) leaves a going chip to finish.
      if (!end) return setChip((now) => (swipe && walk.can(side) ? { side, travel: Math.min(Math.abs(dx) / SWIPE_ARM, 1) } : now?.gone ? now : null));
      const went = swipe && Math.abs(dx) >= SWIPE_ARM && walk.can(side);
      if (went) walk.go(side);
      setChip((now) => now && { ...now, gone: went ? "went" : "short" });
    };
    const onWheel = (event: WheelEvent) => {
      if (swiping && event.timeStamp - swiping.at > SWIPE_STALE_MS) swiping = null;
      const target = event.target instanceof Element ? event.target : null;
      swiping ??= { dx: 0, events: 0, at: 0, ours: Math.abs(event.deltaX) > Math.abs(event.deltaY) && !event.defaultPrevented && !blocked() && !target?.closest(".brigadier-agent-frame, .session-tab-list") && !scrollsSideways(target, event.deltaX) };
      swiping.at = event.timeStamp;
      if (!swiping.ours) return;
      swiping.dx += event.deltaX;
      swiping.events += 1;
      swiped(app, swiping.dx, swiping.events, false);
    };
    const offScroll = window.brigadier?.onScroll((news) => {
      const ended = swiping;
      swiping = news === "end" ? null : { dx: 0, events: 0, at: performance.now(), ours: false };
      if (!ended?.ours) return;
      if (news === "mouse") setChip(null);
      else swiped(app, ended.dx, ended.events, true);
    });
    const offPage = window.brigadierShell?.onPageSwipe(({ from, dx, events, end }) => {
      const page = guestPage(from);
      if (page) swiped({ can: (side) => (side < 0 ? page.canGoBack() : page.canGoForward()), go: (side) => (side < 0 ? page.goBack() : page.goForward()) }, dx, events, end);
      // Its page closed mid-swipe, or an agent holds it: the chip goes, short.
      else if (end) setChip((now) => now && { ...now, gone: "short" });
    });
    addEventListener("keydown", onKeyDown);
    addEventListener("mousedown", onMouse);
    addEventListener("mouseup", onMouse);
    addEventListener("wheel", onWheel, { passive: true });
    return () => {
      offMenu?.();
      offScroll?.();
      offPage?.();
      removeEventListener("wheel", onWheel);
      removeEventListener("keydown", onKeyDown);
      removeEventListener("mousedown", onMouse);
      removeEventListener("mouseup", onMouse);
    };
  });
  // Back and Forward (our arrows [D217]), then the toggle, Settings too [D254 D265]; hidden, Search in the strip's look [D297].
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
          {/* Its name says what a click does; aria-expanded would draw an open fill. */}
          <TooltipIconButton look="strip" tip={false} tooltip={open ? "Hide sidebar" : "Show sidebar"} data-slot="sidebar-toggle" onClick={toggleSidebar}>
            {open ? <Sidebar /> : <SidebarFloatingLeft />}
          </TooltipIconButton>
          {!open && (
            <TooltipIconButton look="strip" tooltip="Search" shortcut={keysOf("search")[0]} onClick={openSearch}>
              <MagnifyingGlassSearch />
            </TooltipIconButton>
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
