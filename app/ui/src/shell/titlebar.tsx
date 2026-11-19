import { useEffect } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { useSidebar } from "../components/sidebar";
import { Minus, Sidebar, SidebarFloatingLeft, X } from "../icons";
import { store } from "../onboarding/api";
import { settingsPageOf, settingsUp } from "../settings/shell";
import { matches } from "../shortcuts";
import type { SessionRow } from "../sidebar/words";

// The old app's history (state/history.ts) [kit D170]: Back goes by where you are, never by how you got there, a
// session to Home, Settings up a level and out (settingsUp), and Home has nowhere to go. Forward redoes what Back left; any other navigation clears it.
const ahead = store<string | null>(null);
let stepping: string | null = null;
window.addEventListener("hashchange", () => {
  if (window.location.hash !== stepping) ahead.set(null);
  stepping = null;
});

const MOUSE_BACK = 3;
const MOUSE_FORWARD = 4;
// An empty listbox is no menu: a note's editor keeps one, Lexical's typeahead anchor, while its / menu is shut [D291].
export const blocked = () => document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]:not(:empty)') !== null;

/** The traffic lights' x on the tab bar's row, the same in every sidebar mode [D48]. The real lights are 60px wide, not the board's 52. */
const LIGHTS_X = 13;

/**
 * Back and Forward by their keys, mouse buttons and menu items, with no buttons [D861 D862], and the sidebar toggle: at
 * the end of the sidebar's name row, above the strip's logo, or after the traffic lights while hidden, gliding between
 * them with the sidebar (sidebar-toggle). It steps open, strip, hidden, and open again [D654 D800].
 */
export function TitlebarNav({ hash, rows }: { hash: string; rows: SessionRow[] | undefined }) {
  const { open, collapse, toggleSidebar, canToggle } = useSidebar();
  const mode = open ? "open" : collapse === "hidden" ? "hidden" : "strip";
  useEffect(() => window.brigadier?.trafficLights?.(LIGHTS_X), []);
  const forward = ahead.use();
  const page = settingsPageOf(hash);
  const up = page !== null ? settingsUp(page) : hash.startsWith("#thread/") || hash.startsWith("#project/") ? "" : null;
  // A session deleted since shows Home instead.
  const go = (place: string) => {
    const gone = place.startsWith("#thread/") && rows && !rows.some((row) => row.id === decodeURIComponent(place.slice("#thread/".length)));
    stepping = gone ? "" : place;
    window.location.hash = stepping;
  };
  const stepBack = () => {
    if (up === null) return;
    ahead.set(hash);
    go(up);
  };
  const stepForward = () => {
    if (forward === null) return;
    ahead.set(null);
    go(forward);
  };
  const step = (delta: -1 | 1) => {
    if (!blocked()) (delta === -1 ? stepBack : stepForward)();
  };
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
    addEventListener("keydown", onKeyDown);
    addEventListener("mousedown", onMouse);
    addEventListener("mouseup", onMouse);
    return () => {
      offMenu?.();
      removeEventListener("keydown", onKeyDown);
      removeEventListener("mousedown", onMouse);
      removeEventListener("mouseup", onMouse);
    };
  });
  // Its name says what a click does; aria-expanded would draw an open fill. Settings holds the panel open, so it has none [D34].
  if (!canToggle) return null;
  return (
    <div data-mode={mode} className="sidebar-toggle app-no-drag fixed z-20 flex">
      <TooltipIconButton look="strip" tip={false} tooltip={{ open: "Collapse sidebar", strip: "Hide sidebar", hidden: "Show sidebar" }[mode]} data-slot="sidebar-toggle" onClick={toggleSidebar}>
        {open ? <Sidebar /> : <SidebarFloatingLeft />}
      </TooltipIconButton>
    </div>
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
