import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton, type TooltipIconButtonProps } from "../components/icon-button";
import { TitlebarTips } from "../components/tooltip";
import { useDaemon } from "../daemon";
import { useHomeDraft, useStart } from "../home/start";
import { SidebarFloatingLeft } from "../icons";
import { useFake } from "../panel/fake";
import { setPanelOpen, setPanelWidth, showPanelView, usePanelMemory } from "../panel/memory";
import type { PanelHint, PanelView } from "../panel/types";
import { VIEWS } from "../panel/views";
import { hintWords } from "../panel/words";
import { useProjects } from "../projects/projects";
import { HOME } from "./tab-store";

/*
 * The right panel [D410, D1014], as the old app's (WorkspacePane, PaneViewTabs): a column at the window's end, its
 * views' icons centred atop it, sliding open and closed as the sidebar does and pushing the chat aside. Its edge
 * drags to resize it; dragged below half its least width, it closes. ⌥⌘B shows or hides it; ⇧⌘E, ⇧⌘F and ⌃⇧G
 * open Files, Search and Source, and pressed while that view shows, move the keyboard into it [D48].
 */

const TABS: { view: PanelView; title: string; shortcut: string }[] = [
  { view: "files", title: "Files", shortcut: "⇧⌘E" },
  { view: "search", title: "Search", shortcut: "⇧⌘F" },
  { view: "source", title: "Source", shortcut: "⌃⇧G" },
];

/** Sessions and project chats have it; a chat in no project doesn't, before or after its first message [D1014, D1039, D421]. */
function useHasPanel(owner: string): boolean {
  const draft = useHomeDraft();
  const projects = useProjects();
  const row = useDaemon().rows?.find((each) => each.id === owner);
  const starting = useStart(owner);
  if (owner === HOME) return !draft.chat && Boolean(projects?.some((each) => !each.pending));
  // Hidden only once it's known to be in no project; an owner not listed yet keeps it, as the toolbar does.
  return (row ?? starting)?.project !== null;
}

/** What the panel draws for `owner`: fake until step 2.15 wires it to Rust. */
function usePanelData(owner: string) {
  return useFake(owner, owner === HOME);
}

const DOT: Record<PanelHint["tone"], string> = { changes: "bg-link", ready: "bg-success", conflict: "bg-warning", failed: "bg-destructive" };

/** The toggle as drawn: its dot and tip follow the most urgent state [D1022, D1025]. */
export function PanelToggleButton({ hint, open, ...props }: { hint: PanelHint | null; open: boolean } & Omit<TooltipIconButtonProps, "tooltip">) {
  return (
    <TooltipIconButton look="toolbar" tooltip={hintWords(hint)} shortcut="⌥⌘B" pressed={open} dot={hint ? DOT[hint.tone] : undefined} aria-controls="right-panel-content" {...props}>
      {/* The left toggle's folded icon, mirrored. */}
      <SidebarFloatingLeft className="-scale-x-100" />
    </TooltipIconButton>
  );
}

/** The toolbar's rightmost button [D1014]. With a dot, a click opens the view it's about; the dot hides while that shows. */
export function RightPanelToggle({ owner, className }: { owner: string; className?: string | false }) {
  const memory = usePanelMemory();
  const has = useHasPanel(owner);
  const { hint } = usePanelData(owner);
  const view = memory.views[owner] ?? "files";
  const showing = memory.open && view === "source";
  if (!has) return null;
  return (
    <span className={cx("app-no-drag flex", className)}>
      <PanelToggleButton
        hint={showing ? null : hint}
        open={memory.open}
        onClick={() => (hint && !showing ? showPanelView(owner, "source") : setPanelOpen(!memory.open))}
      />
    </span>
  );
}

/** Which key asks what: ⌥⌘B shows or hides it, the others a view. */
function panelKey(event: KeyboardEvent): "toggle" | PanelView | null {
  if (event.isComposing || event.repeat) return null;
  const command = event.metaKey && !event.ctrlKey;
  if (command && event.altKey && !event.shiftKey && event.code === "KeyB") return "toggle";
  if (command && event.shiftKey && !event.altKey && event.code === "KeyE") return "files";
  if (command && event.shiftKey && !event.altKey && event.code === "KeyF") return "search";
  if (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && event.code === "KeyG") return "source";
  return null;
}

/** Where the right panel mounts, below the tab bar and beside the chat [D361, D410]. */
export function RightPanelSlot({ owner }: { owner: string }) {
  const has = useHasPanel(owner);
  const memory = usePanelMemory();
  const view = memory.views[owner] ?? "files";
  const open = has && memory.open;
  const data = usePanelData(owner);
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
      if (memory.open && view === asked) {
        content.current?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex="0"]')?.focus();
      } else showPanelView(owner, asked);
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [has, memory.open, view, owner]);

  if (!has) return null;
  const { View } = VIEWS[view];
  return (
    <aside
      aria-label="Right sidebar"
      data-state={open ? "expanded" : "collapsed"}
      data-width={memory.width ?? undefined}
      className={cx("right-panel-width-source start-hairline relative flex h-full min-h-0 shrink-0 before:transition-opacity motion-reduce:before:transition-none", !open && "before:opacity-0")}
    >
      <div
        inert={!open}
        data-resizing={resizing || undefined}
        onTransitionEnd={(event) => event.target === event.currentTarget && !open && setShown(false)}
        className={cx("sidebar-motion h-full overflow-clip", open ? "right-panel-width" : "w-0")}
      >
        <div className="right-panel-width flex h-full min-h-0 flex-col">
          <ViewTabs active={view} count={data.count} onSelect={(next) => showPanelView(owner, next)} />
          <div ref={content} id="right-panel-content" role="tabpanel" aria-labelledby={`right-panel-${view}`} className="flex min-h-0 flex-1 flex-col">
            {shown && <View key={owner} owner={owner} />}
          </div>
        </div>
      </div>
      {open && <ResizeHandle resizing={resizing} setResizing={setResizing} />}
    </aside>
  );
}

/** The row of view icons, as tabs: Files, Search and Source with its count; arrows, Home and End move along it. */
export function ViewTabs({ active, count, onSelect }: { active: PanelView; count: number; onSelect: (view: PanelView) => void }) {
  return (
    <div role="tablist" aria-label="Right sidebar" className="flex h-page-toolbar shrink-0 items-center justify-center gap-1 px-2">
      <TitlebarTips>
        {TABS.map(({ view, title, shortcut }, index) => {
          const { Icon } = VIEWS[view];
          return (
            <TooltipIconButton
              key={view}
              look="toolbar"
              role="tab"
              id={`right-panel-${view}`}
              aria-controls="right-panel-content"
              aria-selected={active === view}
              tabIndex={active === view ? 0 : -1}
              tooltip={title}
              shortcut={shortcut}
              className="relative aria-selected:bg-fill-subtle aria-selected:text-foreground"
              onClick={() => onSelect(view)}
              onKeyDown={(event) => {
                const next =
                  event.key === "ArrowRight" ? (index + 1) % TABS.length
                  : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length
                  : event.key === "Home" ? 0
                  : event.key === "End" ? TABS.length - 1
                  : null;
                if (next === null) return;
                event.preventDefault();
                onSelect(TABS[next]!.view);
                document.getElementById(`right-panel-${TABS[next]!.view}`)?.focus();
              }}
            >
              <Icon />
              {view === "source" && count > 0 && (
                <span aria-hidden className="absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-capsule bg-link px-1 text-2xs text-background tabular-nums">
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </TooltipIconButton>
          );
        })}
      </TitlebarTips>
    </div>
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
