import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { TitlebarTips } from "../components/tooltip";
import { useDaemon } from "../daemon";
import { FilesView } from "../files/views";
import { useHomeDraft, useStart } from "../home/start";
import { Agent, FilesGlyph, Sidebar, SidebarFloatingLeft } from "../icons";
import { useGitWatch } from "../panel/git";
import { openPanel, type PanelTab, setPanelOpen, setPanelWidth, usePanelFromRust, usePanelMemory, usePanelTab } from "../panel/memory";
import { useArchivedGitNotice } from "../panel/notice";
import { useProjects } from "../projects/projects";
import { keysOf, matches } from "../shortcuts";
import { WORKERS_LABEL } from "../workers/list";
import { finishedWords, useWorkers, WorkersPane } from "../workers/live";
import { useAgents } from "../workers/subagents";
import { HOME, openFile, useTabs } from "./tab-store";

/*
 * The right panel [D410, D1014], as the old app's (WorkspacePane): a column at the window's end holding Files [D1284]
 * and Workers [D56], their icons in a row at its top, sliding open and closed as the sidebar does and pushing the chat
 * aside. Its edge drags to resize it, one width for both; dragged below half its least width, it closes. ⌥⌘B shows or
 * hides it on its last view; ⇧⌘E shows Files, or hides the panel where Files already shows [D1284, D58].
 */

/** Sessions and project chats have Files; a chat in no project doesn't, before or after its first message [D1014, D1039, D421]. */
export function useHasPanel(owner: string): boolean {
  const draft = useHomeDraft();
  const projects = useProjects();
  const row = useDaemon().rows?.find((each) => each.id === owner);
  const starting = useStart(owner);
  if (owner === HOME) return !draft.chat && Boolean(projects?.some((each) => !each.pending));
  // Hidden only once it's known to be in no project; an owner not listed yet keeps it, as the toolbar does.
  return (row ?? starting)?.project !== null;
}

const BOTH: readonly PanelTab[] = ["files", "workers"];
const TEAM: readonly PanelTab[] = ["workers"];
const NONE: readonly PanelTab[] = [];

/** The panel's views for `owner`: Files and Workers where it has Files, else Workers once it has workers, else none. */
export function usePanelViews(owner: string): readonly PanelTab[] {
  const files = useHasPanel(owner);
  const team = useWorkers(owner).length + useAgents(owner).length > 0;
  return files ? BOTH : team ? TEAM : NONE;
}

/** The toolbar's rightmost button [D1014, D56]: the left toggle's icon mirrored, as the old app's; a click always shows or hides the panel. */
export function RightPanelToggle({ owner, className }: { owner: string; className?: string | false }) {
  const memory = usePanelMemory();
  if (usePanelViews(owner).length === 0) return null;
  return (
    <span className={cx("app-no-drag flex", className)}>
      <TooltipIconButton look="toggle" tooltip="Right panel" shortcut={keysOf("right-panel")[0]} pressed={memory.open} aria-controls="right-panel-content" onClick={() => setPanelOpen(!memory.open)}>
        {memory.open ? <Sidebar className="-scale-x-100" /> : <SidebarFloatingLeft className="-scale-x-100" />}
      </TooltipIconButton>
    </span>
  );
}

/** Files lights up the file whose tab is in front; a click opens it in the preview tab, a double click keeps it. */
function Files({ owner }: { owner: string }) {
  const { tabs, active } = useTabs(owner);
  const front = tabs.find((tab) => tab.id === active && tab.kind === "file")?.target ?? null;
  return <FilesView owner={owner} shown={front} onOpen={(path, keep) => openFile(owner, path, { preview: !keep })} />;
}

const VIEWS = { files: { title: "Files", Icon: FilesGlyph }, workers: { title: WORKERS_LABEL, Icon: Agent } } as const;

/**
 * The views' icons as tabs, centred in a row at the panel's top, as the old app's PaneViewTabs: the shown one filled
 * as a pressed toolbar button, each named in its tip with its shortcut; ←/→, Home and End move between them.
 */
function PanelViews({ owner, views, active }: { owner: string; views: readonly PanelTab[]; active: PanelTab }) {
  const finished = finishedWords(useWorkers(owner));
  return (
    <div role="tablist" aria-label="Right panel" className="flex h-11.5 shrink-0 items-center justify-center gap-1 px-2">
      <TitlebarTips>
        {views.map((id, index) => {
          const { title, Icon } = VIEWS[id];
          return (
            <TooltipIconButton
              look="toolbar"
              key={id}
              role="tab"
              id={`right-panel-${id}`}
              aria-controls="right-panel-view"
              aria-selected={active === id}
              tabIndex={active === id ? 0 : -1}
              className="aria-selected:bg-fill-subtle aria-selected:text-foreground aria-selected:hover:bg-fill-hover"
              tooltip={id === "workers" && finished ? `${title} · ${finished}` : title}
              shortcut={id === "files" ? keysOf("show-files")[0] : undefined}
              onClick={() => openPanel(owner, id)}
              onKeyDown={(event) => {
                const step = { ArrowRight: index + 1, ArrowLeft: index - 1 + views.length, Home: 0, End: views.length - 1 }[event.key];
                if (step === undefined) return;
                event.preventDefault();
                const next = views[step % views.length]!;
                openPanel(owner, next);
                document.getElementById(`right-panel-${next}`)?.focus();
              }}
            >
              <Icon />
            </TooltipIconButton>
          );
        })}
      </TitlebarTips>
    </div>
  );
}

/** Where the right panel mounts, below the tab bar and beside the chat [D361, D410]. */
export function RightPanelSlot({ owner }: { owner: string }) {
  useArchivedGitNotice(owner);
  const files = useHasPanel(owner);
  const views = usePanelViews(owner);
  const memory = usePanelMemory();
  const open = views.length > 0 && memory.open;
  const picked = usePanelTab(owner);
  const tab = views.includes(picked) ? picked : views[0];
  usePanelFromRust();
  useGitWatch(files ? owner : null);
  const [resizing, setResizing] = useState(false);
  // Its contents stay through the closing slide, then go, so a closed panel reads nothing.
  const [shown, setShown] = useState(open);
  if (open && !shown) setShown(true);
  useEffect(() => {
    if (!open && shown && matchMedia("(prefers-reduced-motion: reduce)").matches) setShown(false);
  }, [open, shown]);

  useEffect(() => {
    if (views.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented) return;
      const toggle = matches(event, "right-panel");
      if (!toggle && !(files && matches(event, "show-files"))) return;
      event.preventDefault();
      if (toggle) setPanelOpen(!memory.open);
      else if (open && tab === "files") setPanelOpen(false);
      else openPanel(owner, "files");
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [views, files, memory.open, open, tab, owner]);

  if (!tab) return null;
  return (
    <aside
      aria-label="Right panel"
      data-state={open ? "expanded" : "collapsed"}
      data-width={memory.width ?? undefined}
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
            {shown && (
              <>
                <PanelViews owner={owner} views={views} active={tab} />
                <div id="right-panel-view" role="tabpanel" aria-labelledby={`right-panel-${tab}`} className="flex min-h-0 flex-1 flex-col">
                  {tab === "files" ? <Files key={owner} owner={owner} /> : <WorkersPane key={owner} owner={owner} />}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {open && (
        <ResizeHandle label="Resize right panel" resizing={resizing} setResizing={setResizing} onWidth={setPanelWidth} onClose={() => setPanelOpen(false)} />
      )}
    </aside>
  );
}

/** A theme length (rem) in CSS pixels. */
export const px = (name: string) => {
  const root = getComputedStyle(document.documentElement);
  return Number.parseFloat(root.getPropertyValue(name)) * Number.parseFloat(root.fontSize);
};

/** The grab area straddling the right panel's start edge (the old SidebarResizeHandle's right side). */
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
