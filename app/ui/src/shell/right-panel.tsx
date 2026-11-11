import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton, type TooltipIconButtonProps } from "../components/icon-button";
import { useDaemon } from "../daemon";
import { FilesView } from "../files/views";
import { useHomeDraft, useStart } from "../home/start";
import { SidebarFloatingLeft } from "../icons";
import { useGitWatch } from "../panel/git";
import { setPanelOpen, setPanelWidth, usePanelFromRust, usePanelMemory } from "../panel/memory";
import { useProjects } from "../projects/projects";
import { HOME, openFile, useTabs } from "./tab-store";

/*
 * The right panel [D410, D1014], as the old app's (WorkspacePane): a column at the window's end holding Files [D1284],
 * sliding open and closed as the sidebar does and pushing the chat aside. Its edge drags to resize it; dragged below
 * half its least width, it closes. ⌥⌘B shows or hides it; ⇧⌘E opens it, and pressed while it shows, moves the
 * keyboard into it [D48].
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
    <TooltipIconButton look="toolbar" tooltip="Right sidebar" shortcut="⌥⌘B" pressed={open} aria-controls="right-panel-content" {...props}>
      {/* The left toggle's folded icon, mirrored. */}
      <SidebarFloatingLeft className="-scale-x-100" />
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

/** Which key asks what: ⌥⌘B shows or hides it, ⇧⌘E opens Files. */
function panelKey(event: KeyboardEvent): "toggle" | "files" | null {
  if (event.isComposing || event.repeat) return null;
  const command = event.metaKey && !event.ctrlKey;
  if (command && event.altKey && !event.shiftKey && event.code === "KeyB") return "toggle";
  if (command && event.shiftKey && !event.altKey && event.code === "KeyE") return "files";
  return null;
}

/** Files lights up the file whose tab is in front; a click opens it in the preview tab, a double click keeps it. */
function Files({ owner }: { owner: string }) {
  const { tabs, active } = useTabs(owner);
  const front = tabs.find((tab) => tab.id === active && tab.kind === "file")?.target ?? null;
  return <FilesView owner={owner} shown={front} onOpen={(path, keep) => openFile(owner, path, { preview: !keep })} />;
}

/** Where the right panel mounts, below the tab bar and beside the chat [D361, D410]. */
export function RightPanelSlot({ owner }: { owner: string }) {
  const has = useHasPanel(owner);
  const memory = usePanelMemory();
  const open = has && memory.open;
  usePanelFromRust();
  useGitWatch(has ? owner : null);
  const content = useRef<HTMLDivElement>(null);
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
      const asked = panelKey(event);
      if (!asked || event.defaultPrevented) return;
      event.preventDefault();
      if (asked === "toggle") return setPanelOpen(!memory.open);
      if (memory.open) {
        content.current?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex="0"]')?.focus();
      } else setPanelOpen(true);
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [has, memory.open]);

  if (!has) return null;
  return (
    <aside
      aria-label="Right sidebar"
      data-state={open ? "expanded" : "collapsed"}
      data-width={memory.width ?? undefined}
      className={cx("right-panel-width-source start-hairline relative flex h-full min-h-0 shrink-0 before:transition-opacity before:duration-300 before:ease-sidebar motion-reduce:before:transition-none", !open && "before:opacity-0")}
    >
      <div
        inert={!open}
        data-resizing={resizing || undefined}
        onTransitionEnd={(event) => event.target === event.currentTarget && !open && setShown(false)}
        className={cx("sidebar-motion h-full overflow-clip", open ? "right-panel-width" : "w-0")}
      >
        <div className="right-panel-width flex h-full min-h-0 flex-col">
          <div ref={content} id="right-panel-content" className="flex min-h-0 flex-1 flex-col">
            {shown && <Files key={owner} owner={owner} />}
          </div>
        </div>
      </div>
      {open && <ResizeHandle resizing={resizing} setResizing={setResizing} />}
    </aside>
  );
}

/** The grab area straddling the panel's start edge (the old SidebarResizeHandle's right side). */
function ResizeHandle({ resizing, setResizing }: { resizing: boolean; setResizing: (resizing: boolean) => void }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const latest = useRef<number | null>(null);
  // A theme length (rem) in CSS pixels.
  const px = (name: string) => {
    const root = getComputedStyle(document.documentElement);
    return Number.parseFloat(root.getPropertyValue(name)) * Number.parseFloat(root.fontSize);
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setResizing(false);
    if (latest.current !== null) setPanelWidth(latest.current);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize right sidebar"
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
          setPanelOpen(false);
          return;
        }
        latest.current = Math.round(Math.min(Math.max(wanted, min), px("--spacing-sidebar-max")));
        // Follows the pointer without a render; the width is kept when the drag ends.
        event.currentTarget.parentElement?.setAttribute("data-width", String(latest.current));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      className="group/resize absolute start-0 top-0 bottom-0 z-10 flex w-resize-handle -translate-x-1/2 cursor-col-resize justify-center rtl:translate-x-1/2"
    >
      <span className="w-px bg-input opacity-0 transition-opacity group-hover/resize:opacity-100 group-data-resizing/resize:opacity-100" />
    </div>
  );
}
