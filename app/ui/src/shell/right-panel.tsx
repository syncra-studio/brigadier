import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton, type TooltipIconButtonProps } from "../components/icon-button";
import { useDaemon } from "../daemon";
import { FilesView } from "../files/views";
import { useHomeDraft, useStart } from "../home/start";
import { Folders } from "../icons";
import { useGitWatch } from "../panel/git";
import { setPanelOpen, setPanelWidth, usePanelFromRust, usePanelMemory } from "../panel/memory";
import { useArchivedGitNotice } from "../panel/notice";
import { useProjects } from "../projects/projects";
import { keysOf, matches } from "../shortcuts";
import { HOME, openFile, useTabs } from "./tab-store";

/*
 * The right panel [D410, D1014], as the old app's (WorkspacePane): a column at the window's end holding Files [D1284],
 * sliding open and closed as the sidebar does and pushing the chat aside. Its edge drags to resize it; dragged below
 * half its least width, it closes. ⌥⌘B and ⇧⌘E show or hide Files [D1284].
 */

/** Sessions and project chats have it; a chat in no project doesn't, before or after its first message [D1014, D1039, D421]. */
export function useHasPanel(owner: string): boolean {
  const draft = useHomeDraft();
  const projects = useProjects();
  const row = useDaemon().rows?.find((each) => each.id === owner);
  const starting = useStart(owner);
  if (owner === HOME) return !draft.chat && Boolean(projects?.some((each) => !each.pending));
  // Hidden only once it's known to be in no project; an owner not listed yet keeps it, as the toolbar does.
  return (row ?? starting)?.project !== null;
}

/** The toggle as drawn. */
export function PanelToggleButton({ open, ...props }: { open: boolean } & Omit<TooltipIconButtonProps, "tooltip">) {
  return (
    <TooltipIconButton look="toggle" tooltip="Files" shortcut={keysOf("show-files")[0]} pressed={open} aria-controls="right-panel-content" {...props}>
      <Folders />
    </TooltipIconButton>
  );
}

/** The toolbar's rightmost button [D1014]: a click always shows or hides the panel, as the old app's. */
export function RightPanelToggle({ owner, className }: { owner: string; className?: string | false }) {
  const memory = usePanelMemory();
  const has = useHasPanel(owner);
  if (!has) return null;
  return (
    <span className={cx("app-no-drag flex", className)}>
      <PanelToggleButton open={memory.open} onClick={() => setPanelOpen(!memory.open)} />
    </span>
  );
}

/** Both Files shortcuts show or hide it [D1284]. */
function panelKey(event: KeyboardEvent): boolean {
  return !event.repeat && (matches(event, "right-panel") || matches(event, "show-files"));
}

/** Files lights up the file whose tab is in front; a click opens it in the preview tab, a double click keeps it. */
function Files({ owner }: { owner: string }) {
  const { tabs, active } = useTabs(owner);
  const front = tabs.find((tab) => tab.id === active && tab.kind === "file")?.target ?? null;
  return <FilesView owner={owner} shown={front} onOpen={(path, keep) => openFile(owner, path, { preview: !keep })} />;
}

/** Where the right panel mounts, below the tab bar and beside the chat [D361, D410]; `beside`: the Workers panel's width while it shows. */
export function RightPanelSlot({ owner, beside = 0 }: { owner: string; beside?: number }) {
  useArchivedGitNotice(owner);
  const has = useHasPanel(owner);
  const memory = usePanelMemory();
  const open = has && memory.open;
  usePanelFromRust();
  useGitWatch(has ? owner : null);
  const [resizing, setResizing] = useState(false);
  // Its contents stay through the closing slide, then go, so a closed panel reads nothing.
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  useEffect(() => {
    if (!open && shown && matchMedia("(prefers-reduced-motion: reduce)").matches) setShown(false);
  }, [open, shown]);

  useEffect(() => {
    if (!has) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!panelKey(event) || event.defaultPrevented) return;
      event.preventDefault();
      setPanelOpen(!memory.open);
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [has, memory.open]);

  if (!has) return null;
  return (
    <aside
      aria-label="Files"
      data-state={open ? "expanded" : "collapsed"}
      data-width={memory.width ?? undefined}
      data-beside={beside || undefined}
      className="right-panel-width-source relative flex h-full min-h-0 shrink-0"
    >
      <div
        inert={!open}
        data-resizing={resizing || undefined}
        onTransitionEnd={(event) => event.target === event.currentTarget && !open && setShown(false)}
        className={cx("sidebar-motion h-full overflow-clip", open ? "right-panel-width" : "w-0")}
      >
        {/* A floating card 4px off the thread and 6px under the tab bar [new-design]. */}
        <div className="right-panel-width flex h-full min-h-0 flex-col ps-1 pt-1.5">
          <div id="right-panel-content" className="flex min-h-0 flex-1 flex-col overflow-clip rounded-panel bg-card ring-1 ring-glass-stroke ring-inset resize-lit:inset-shadow-resize-start rtl:resize-lit:inset-shadow-resize-end">
            {shown && <Files key={owner} owner={owner} />}
          </div>
        </div>
      </div>
      {open && (
        <ResizeHandle label="Resize Files" resizing={resizing} setResizing={setResizing} onWidth={setPanelWidth} onClose={() => setPanelOpen(false)} />
      )}
    </aside>
  );
}

/** A theme length (rem) in CSS pixels. */
export const px = (name: string) => {
  const root = getComputedStyle(document.documentElement);
  return Number.parseFloat(root.getPropertyValue(name)) * Number.parseFloat(root.fontSize);
};

/** The grab area straddling a right column's start edge (the old SidebarResizeHandle's right side): Files' and Workers'. */
export function ResizeHandle({ label, resizing, setResizing, onWidth, onClose }: {
  label: string;
  resizing: boolean;
  setResizing: (resizing: boolean) => void;
  onWidth: (width: number) => void;
  onClose: () => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const latest = useRef<number | null>(null);

  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setResizing(false);
    if (latest.current !== null) onWidth(latest.current);
  };

  return (
    <div
      role="separator"
      data-slot="resize-handle"
      aria-orientation="vertical"
      aria-label={label}
      data-resizing={resizing || undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const panel = event.currentTarget.parentElement?.firstElementChild;
        if (!panel) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width: panel.getBoundingClientRect().width };
        latest.current = null;
        setResizing(true);
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        // A release that never reached the handle still ends the drag, so the width is kept app-wide [D1033].
        if (!(event.buttons & 1)) return end(event);
        const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
        const wanted = start.current.width - (event.clientX - start.current.x) * (rtl ? -1 : 1);
        const min = px("--spacing-sidebar-min");
        if (wanted < min / 2) {
          // Closed by the drag, it keeps the width it had when the drag began, for when it opens again.
          latest.current = Math.round(start.current.width);
          event.currentTarget.parentElement?.setAttribute("data-width", String(latest.current));
          end(event);
          onClose();
          return;
        }
        latest.current = Math.round(Math.min(Math.max(wanted, min), px("--spacing-sidebar-max")));
        // Follows the pointer without a render; the width is kept when the drag ends.
        event.currentTarget.parentElement?.setAttribute("data-width", String(latest.current));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      className="absolute start-0 top-0 bottom-0 z-10 w-resize-handle -translate-x-1/2 cursor-col-resize rtl:translate-x-1/2"
    >
    </div>
  );
}
