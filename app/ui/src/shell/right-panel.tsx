import { useEffect, useState } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton, type TooltipIconButtonProps } from "../components/icon-button";
import { ResizeHandle } from "../components/resize-handle";
import { Sidebar } from "../icons";
import { useDaemon } from "../daemon";
import { FilesView, useFilesAhead } from "../files/views";
import { useHomeDraft, useStart } from "../home/start";
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

/** The toggle as drawn: 32 round at the row's end, pressed while open [D40]. */
export function PanelToggleButton({ open, ...props }: { open: boolean } & Omit<TooltipIconButtonProps, "tooltip">) {
  return (
    <TooltipIconButton look="round" tooltip="Files" shortcut={keysOf("show-files")[0]} pressed={open} aria-controls="right-panel-content" {...props}>
      {/* The sidebar's icon, mirrored [D40]. */}
      <Sidebar className="-scale-x-100" />
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

/** Where the right panel mounts, below the tab bar and beside the chat [D361, D410]. */
export function RightPanelSlot({ owner }: { owner: string }) {
  useArchivedGitNotice(owner);
  const has = useHasPanel(owner);
  const memory = usePanelMemory();
  const open = has && memory.open;
  usePanelFromRust();
  useGitWatch(has ? owner : null);
  useFilesAhead(owner, !has || open);
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
      data-slot="right-panel"
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
          <div id="right-panel-content" className="flex min-h-0 flex-1 flex-col">
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
