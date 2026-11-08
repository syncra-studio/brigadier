import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { EmptyState } from "../components/empty-state";
import { TooltipIconButton } from "../components/icon-button";
import { NavFold, NavHeader, NavList, NavRow, NavSection } from "../components/nav";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { Radio, RadioGroup } from "../components/radio";
import { RowAction } from "../components/row-action";
import { SidebarPanel, useSidebar } from "../components/sidebar";
import { Skeleton } from "../components/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ComposeEditSquare, Folder, FolderOpen, Plus, SettingsSlider } from "../icons";
import { BrigadierMark } from "../onboarding/mark";
import { SearchPalette, searchText, type TextSearch } from "../palette/palette";
import { openAddProject, setShowProject, showProject } from "../projects/store";
import { markUnread, pin, rename, useShown } from "./actions";
import { RenameDialog } from "./menu";
import { NeedYouPill } from "./pill";
import { SessionRowItem } from "./row";
import type { Project, SessionRow } from "./words";

/*
 * The app's sidebar [D173, D174]: New session, then the sessions in one of two layouts, picked in View.
 * Group by None is one list across projects, each row with its project's badge. Group by Project lists
 * the projects by name, each folding its own sessions. Rows go by the user's last send, newest first,
 * so a row never moves while it works. Layout and folds are this window's view, kept in localStorage.
 */

type Grouping = "none" | "project";

/** A view choice kept across launches. */
export function useStored<T>(key: string, initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const saved = localStorage.getItem(key);
    return saved === null ? initial : (JSON.parse(saved) as T);
  });
  return [
    value,
    (next) => {
      localStorage.setItem(key, JSON.stringify(next));
      setValue(next);
    },
  ];
}

const byLastSend = (a: SessionRow, b: SessionRow) => b.sent - a.sent || b.id.localeCompare(a.id);
const LIST = "scroll-edge-fade flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pt-1 pb-2";
const MENU_ROW = "flex h-control-sm cursor-pointer items-center gap-2 rounded-menu-item px-2 text-sm hover:bg-fill has-focus-visible:bg-fill";

export function AppSidebar({
  rows,
  projects,
  active,
  home,
  offline,
  onOpen,
  onNewSession,
  foot,
  storeKey = "sidebar",
  search = searchText,
}: {
  /** undefined until the first list arrives. */
  rows: SessionRow[] | undefined;
  projects: Project[];
  /** The open session's id. */
  active: string | null;
  /** The home page (a new session) is what shows. */
  home: boolean;
  offline: boolean;
  onOpen: (id: string) => void;
  onNewSession: () => void;
  foot?: ReactNode;
  /** Where its view is kept; the gallery's demos keep theirs apart. */
  storeKey?: string;
  /** ⌘K's search over message text; the gallery's demos answer from fake data. */
  search?: TextSearch;
}) {
  const [grouping, setGrouping] = useStored<Grouping>(`${storeKey}.grouping`, "none");
  const [folded, setFolded] = useStored<string[]>(`${storeKey}.folded`, []);
  const [renaming, setRenaming] = useState<SessionRow | null>(null);
  const [searching, setSearching] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const isOpen = (key: string) => !folded.includes(key);
  const setOpen = (key: string, open: boolean) => setFolded(open ? folded.filter((each) => each !== key) : [...folded, key]);
  const shown = useShown(rows);
  const projectOf = new Map(projects.map((project) => [project.id, project]));
  // Pinned rows sit in Pinned only, the latest pin first; the rest by last send [D185].
  const pinned = shown?.filter((each) => each.pinned).toSorted((a, b) => b.pinned! - a.pinned! || byLastSend(a, b)) ?? [];
  const rest = shown?.filter((each) => !each.pinned).toSorted(byLastSend);
  const homeless = rest?.filter((each) => each.project === null || !projectOf.has(each.project)) ?? [];
  const byName = projects.toSorted((a, b) => a.name.localeCompare(b.name));
  // Each section's rows top to bottom, keyed by what folds them: the order ⌥⌘A goes in and the pill counts.
  const sections: [string[], SessionRow[]][] =
    grouping === "none"
      ? [
          [["pinned"], pinned],
          [["open"], rest ?? []],
        ]
      : [
          [["pinned"], pinned],
          ...byName.map((project): [string[], SessionRow[]] => [["projects", project.id], rest?.filter((each) => each.project === project.id) ?? []]),
          [["none"], homeless],
        ];
  const order = sections.flatMap(([, each]) => each);
  const activeRow = order.find((each) => each.id === active);

  // Unfolds what holds a row, then brings it into view.
  const reveal = (id: string) => {
    const keys = sections.find(([, each]) => each.some((row) => row.id === id))?.[0] ?? [];
    if (keys.some((key) => !isOpen(key))) setFolded(folded.filter((key) => !keys.includes(key)));
    requestAnimationFrame(() => list.current?.querySelector(`[data-row-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }));
  };
  // ⌥⌘A: the next session waiting on you below the open one, wrapping once [D185].
  const nextNeedingYou = () => {
    const at = order.findIndex((each) => each.id === active);
    const next = [...order.slice(at + 1), ...order.slice(0, Math.max(at, 0))].find((each) => each.mark === "needs");
    if (!next) return;
    onOpen(next.id);
    reveal(next.id);
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.repeat || event.isComposing) return;
      const key = `${event.altKey ? "⌥" : ""}${event.shiftKey ? "⇧" : ""}${event.code}`;
      const action = {
        "⌥KeyA": nextNeedingYou,
        "⌥KeyP": activeRow && (() => pin(activeRow, !activeRow.pinned)),
        "⌥KeyR": activeRow && (() => setRenaming(activeRow)),
        "⇧KeyU": activeRow && (() => markUnread(activeRow, true)),
        KeyK: () => setSearching(true),
      }[key];
      if (!action) return;
      event.preventDefault();
      action();
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  });

  const row = (each: SessionRow, layout: { badged?: boolean; nested?: boolean }) => (
    <SessionRowItem
      key={each.id}
      row={each}
      project={each.project === null ? undefined : projectOf.get(each.project)}
      active={each.id === active}
      offline={offline}
      onOpen={onOpen}
      onRename={setRenaming}
      {...layout}
    />
  );
  const view = <ViewMenu grouping={grouping} onGrouping={setGrouping} />;
  // Add project shows a project already added here: grouped by project, unfolded, in view [D165].
  useEffect(() => {
    setShowProject((id) => {
      setGrouping("project");
      setFolded(folded.filter((key) => key !== "projects" && key !== id));
      requestAnimationFrame(() => document.querySelector(`[data-project-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }));
    });
  });
  // Counted where its sections are unfolded, without the open session [D200].
  const attention = sections
    .filter(([keys]) => keys.every(isOpen))
    .flatMap(([, each]) => each)
    .filter((each) => each.id !== active && (each.mark === "needs" || each.mark === "amber"));

  return (
    <SidebarPanel strip={<Strip onNewSession={onNewSession} />} foot={foot}>
      <NavHeader title="Brigadier" />
      <NavList className="mb-2 px-2">
        <li>
          <NavRow data-active={home || undefined} onClick={onNewSession}>
            <ComposeEditSquare />
            New session
          </NavRow>
        </li>
      </NavList>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={list} className={LIST}>
          {rest === undefined ? (
            <Loading />
          ) : (
            <>
              {pinned.length > 0 && (
                <NavSection title="Pinned" open={isOpen("pinned")} onOpenChange={(open) => setOpen("pinned", open)}>
                  <NavList className="gap-1">{pinned.map((each) => row(each, { badged: true }))}</NavList>
                </NavSection>
              )}
              {grouping === "none" ? (
                <NavSection title="Open" open={isOpen("open")} onOpenChange={(open) => setOpen("open", open)} steadyEnd={view}>
                  <NavList className="gap-1">
                    {rest.map((each) => row(each, { badged: true }))}
                    {shown?.length === 0 && <EmptyState as="li" title="Sessions you start appear here." />}
                  </NavList>
                </NavSection>
              ) : (
                <>
                  <NavSection
                    title="Projects"
                    open={isOpen("projects")}
                    onOpenChange={(open) => setOpen("projects", open)}
                    steadyEnd={view}
                    actions={
                      <Tooltip>
                        <TooltipTrigger render={<RowAction aria-label="Add project" onClick={() => openAddProject()} />}>
                          <Plus />
                        </TooltipTrigger>
                        <TooltipContent side="bottom">Add project</TooltipContent>
                      </Tooltip>
                    }
                  >
                    <NavList>
                      {byName.map((project) => (
                        <ProjectRow
                          key={project.id}
                          id={project.id}
                          name={project.name}
                          open={isOpen(project.id)}
                          onOpenChange={(open) => setOpen(project.id, open)}
                        >
                          {rest.filter((each) => each.project === project.id).map((each) => row(each, { nested: true }))}
                        </ProjectRow>
                      ))}
                      {projects.length === 0 && (
                        <EmptyState
                          as="li"
                          title={
                            <span>
                              Projects group sessions on a repository.{" "}
                              <button
                                type="button"
                                className="cursor-pointer text-foreground underline-offset-link hover:underline"
                                onClick={() => openAddProject()}
                              >
                                Add a project
                              </button>
                            </span>
                          }
                        />
                      )}
                    </NavList>
                  </NavSection>
                  {/* Sessions with no project (made before projects were records) [D224]. */}
                  {homeless.length > 0 && (
                    <NavSection title="No project" open={isOpen("none")} onOpenChange={(open) => setOpen("none", open)}>
                      <NavList>{homeless.map((each) => row(each, {}))}</NavList>
                    </NavSection>
                  )}
                </>
              )}
            </>
          )}
        </div>
        <NeedYouPill list={list} ids={attention.map((each) => each.id)} waiting={attention.some((each) => each.mark === "needs")} />
      </div>
      <RenameDialog row={renaming} onClose={() => setRenaming(null)} onRename={(title) => renaming && rename(renaming, title)} />
      <SearchPalette
        open={searching}
        onOpenChange={setSearching}
        rows={shown}
        projects={projects}
        offline={offline}
        search={search}
        onOpenSession={(id) => {
          onOpen(id);
          reveal(id);
        }}
        onOpenProject={(id) => {
          onNewSession();
          showProject(id);
        }}
      />
    </SidebarPanel>
  );
}

/** Rows to come, until the first list arrives. */
function Loading() {
  return (
    <div role="status" aria-label="Loading sessions" className="flex flex-col gap-1 px-2 pt-7">
      {[0, 1, 2].map((each) => (
        <Skeleton key={each} className="h-6" />
      ))}
    </div>
  );
}

/** A project and its sessions, folding away under it; "No sessions yet" with none. */
function ProjectRow({
  id,
  name,
  open,
  onOpenChange,
  children,
}: {
  id: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode[];
}) {
  return (
    <li data-project-id={id} className="flex flex-col">
      <NavRow aria-expanded={open} onClick={() => onOpenChange(!open)}>
        {open ? <FolderOpen /> : <Folder />}
        <span className="mask-fade-end min-w-0 flex-1 overflow-hidden whitespace-nowrap">{name}</span>
      </NavRow>
      <NavFold open={open}>
        <NavList className="pt-px pb-2">
          {children}
          {children.length === 0 && <EmptyState as="li" className="ps-8" title="No sessions yet" />}
        </NavList>
      </NavFold>
    </li>
  );
}

/** View: Group by None (one list) or Project, on the list's header whichever shows. */
function ViewMenu({ grouping, onGrouping }: { grouping: Grouping; onGrouping: (next: Grouping) => void }) {
  const heading = useId();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={<RowAction aria-label="View" />} />}>
          <SettingsSlider />
        </TooltipTrigger>
        <TooltipContent side="bottom">View</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="end" className="w-60">
        <div id={heading} className="px-2 py-1.5 text-sm text-muted-foreground">
          Group by
        </div>
        <RadioGroup aria-labelledby={heading} value={grouping} onValueChange={(next) => onGrouping(next as Grouping)}>
          {(
            [
              ["none", "None"],
              ["project", "Project"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className={MENU_ROW}>
              <Radio value={value} />
              {label}
            </label>
          ))}
        </RadioGroup>
        <div className="my-1 border-t border-divider" />
        <button
          type="button"
          className={`${MENU_ROW} w-full text-start`}
          onClick={() => {
            setOpen(false);
            openAddProject();
          }}
        >
          <Plus className="size-icon-md text-muted-foreground" />
          Add project…
        </button>
      </PopoverContent>
    </Popover>
  );
}

/** The collapsed strip: the mark, which peeks the panel and opens it, and New session. */
function Strip({ onNewSession }: { onNewSession: () => void }) {
  const { setOpen } = useSidebar();
  return (
    <div className="flex flex-col items-center gap-1 pt-3">
      <TooltipIconButton tooltip="Show sidebar" look="strip" data-sidebar-peek-trigger side="right" onClick={() => setOpen(true)}>
        <BrigadierMark />
      </TooltipIconButton>
      <TooltipIconButton tooltip="New session" look="strip" side="right" onClick={onNewSession}>
        <ComposeEditSquare />
      </TooltipIconButton>
    </div>
  );
}
