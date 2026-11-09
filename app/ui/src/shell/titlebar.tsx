import { useEffect, useState } from "react";

import { Badge } from "../components/badge";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/menu";
import { useSidebar } from "../components/sidebar";
import { TitlebarTips } from "../components/tooltip";
import { useDaemon } from "../daemon";
import { ArrowLeft, ArrowRight, DotsHorizontal, Folder, Sidebar, SidebarFloatingLeft } from "../icons";
import { store } from "../onboarding/api";
import { rename } from "../sidebar/actions";
import { RenameDialog, RowMenuItems } from "../sidebar/menu";
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
const blocked = () => document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null;

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
      if (event.defaultPrevented || event.isComposing || event.shiftKey || event.altKey) return;
      const command = /Mac/.test(navigator.platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const delta = event.code === "BracketLeft" ? -1 : event.code === "BracketRight" ? 1 : 0;
      if (!command || delta === 0) return;
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
        <TooltipIconButton look="toolbar" tooltip="Back" shortcut="⌘[" disabled={active === null} onClick={stepBack}>
          <ArrowLeft />
        </TooltipIconButton>
        <TooltipIconButton look="toolbar" tooltip="Forward" shortcut="⌘]" disabled={forward === null} onClick={stepForward}>
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

/**
 * The window's top beside the sidebar, clear of Back, Forward and the toggle: the open session's folder icon, its
 * title (click to rename, blank until titled) and Archived, then Reconnecting… while the daemon is gone, and ⋯.
 */
export function Titlebar({ offline, row }: { offline: boolean; row?: SessionRow | undefined }) {
  const { projects } = useDaemon();
  const [renaming, setRenaming] = useState(false);
  const project = projects?.find((each) => each.id === row?.project)?.name;
  const archived = Boolean(row?.archived);
  return (
    <header className="app-drag titlebar-clear flex h-titlebar shrink-0 items-center gap-1 pe-1">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        {row?.title && <Folder className="size-icon-md shrink-0 text-muted-foreground" />}
        {row?.title &&
          (archived ? (
            <span className="truncate font-medium">{row.title}</span>
          ) : (
            <button
              type="button"
              title={project ? `${project} · Rename` : "Rename"}
              onClick={() => setRenaming(true)}
              className="app-no-drag min-w-0 cursor-pointer truncate font-medium transition-colors hover:text-action-hover focus-visible:focus-ring"
            >
              {row.title}
            </button>
          ))}
        {archived && (
          <Badge variant="outline" className="ms-1">
            Archived
          </Badge>
        )}
      </div>
      {offline && (
        <Badge variant="warning" role="status">
          Reconnecting…
        </Badge>
      )}
      {row && !archived && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger render={<TooltipIconButton look="toolbar" tooltip="Session actions" className="app-no-drag" />}>
            <DotsHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <RowMenuItems row={row} onRename={() => setRenaming(true)} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <RenameDialog row={renaming && row ? row : null} onClose={() => setRenaming(false)} onRename={(title) => row && rename(row, title)} />
    </header>
  );
}
