import { useEffect } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { useSidebar } from "../components/sidebar";
import { TitlebarTips } from "../components/tooltip";
import { ArrowLeft, ArrowRight, Sidebar, SidebarFloatingLeft } from "../icons";
import { store } from "../onboarding/api";
import { keysOf, matches } from "../shortcuts";
import type { SessionRow } from "../sidebar/words";

// The old app's history (state/history.ts) [kit D170]: Back goes by where you are, never by how you got there, a
// session to Home, and Home has nowhere to go. Forward redoes what Back left; any other navigation clears it.
const ahead = store<string | null>(null);
let stepping: string | null = null;
window.addEventListener("hashchange", () => {
  if (window.location.hash !== stepping) ahead.set(null);
  stepping = null;
});

const MOUSE_BACK = 3;
const MOUSE_FORWARD = 4;
export const blocked = () => document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null;

/** Back, Forward and the sidebar toggle at a fixed spot on the traffic lights' line; they stay put while the sidebar moves. */
export function TitlebarNav({ active, rows }: { active: string | null; rows: SessionRow[] | undefined }) {
  const { open, toggleSidebar } = useSidebar();
  const forward = ahead.use();
  const stepBack = () => {
    if (active === null) return;
    ahead.set(window.location.hash);
    stepping = "";
    window.location.hash = "";
  };
  const stepForward = () => {
    if (forward === null) return;
    // A session deleted since shows Home instead.
    const gone = rows && !rows.some((row) => row.id === decodeURIComponent(forward.slice("#thread/".length)));
    ahead.set(null);
    stepping = gone ? "" : forward;
    window.location.hash = stepping;
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
  return (
    <div className="titlebar-nav app-no-drag absolute start-titlebar-start top-0 z-20 flex h-titlebar items-center gap-1.5">
      <TitlebarTips>
        <TooltipIconButton look="toolbar" tooltip="Back" shortcut={keysOf("back")[0]} disabled={active === null} onClick={stepBack}>
          <ArrowLeft />
        </TooltipIconButton>
        <TooltipIconButton look="toolbar" tooltip="Forward" shortcut={keysOf("forward")[0]} disabled={forward === null} onClick={stepForward}>
          <ArrowRight />
        </TooltipIconButton>
        {/* Its name says which way it goes; aria-expanded would draw the toolbar look's open fill. */}
        <TooltipIconButton look="toolbar" tip={false} tooltip={open ? "Hide sidebar" : "Show sidebar"} data-slot="sidebar-toggle" onClick={toggleSidebar}>
          {open ? <Sidebar /> : <SidebarFloatingLeft />}
        </TooltipIconButton>
      </TitlebarTips>
    </div>
  );
}
