import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import { TooltipIconButton } from "../components/icon-button";
import { NavFold, NavList, NavRow, NavSection } from "../components/nav";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/menu";
import { RowAction, RowActionsSlot } from "../components/row-action";
import { SidebarPanel } from "../components/sidebar";
import { Skeleton } from "../components/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ComposeEditSquare, DotsHorizontal, Folder, FolderOpen, MagnifyingGlassSmSearch, Plus } from "../icons";
import { BrigadierMark } from "../onboarding/mark";
import { openSearch } from "../palette/palette";
import { newSessionIn, ProjectMenuItems } from "../projects/menu";
import { ArchiveAsk, clickRow, useArchiveKeys, useArchiveSplit, usePicked } from "../sessions/archive";
import { ArchivedSection } from "../sessions/archived";
import { openAddProject, setShowProject } from "../projects/store";
import { keysOf, matches } from "../shortcuts";
import { pin, rename, useShown } from "./actions";
import { ArchivedFlyout, ChatsFlyout, NoProjects, PinnedFlyout, ProjectsFlyout } from "./flyout";
import { RenameDialog } from "./menu";
import { NeedYouPill } from "./pill";
import { CARD_DELAY_MS, SessionRowItem } from "./row";
import { type Grouping, useShowFilter, ViewMenu, ViewTrigger } from "./view";
import type { Project, SessionRow } from "./words";

/*
 * The app's sidebar [D173, D174]: New chat, then the sessions in one of two layouts, picked in View.
 * Group by None is one list across projects, each row with its project's badge. Group by Project lists
 * the projects by name, each folding its own sessions. Rows go by the user's last send, newest first,
 * so a row never moves while it works. Layout and folds are this window's view, kept in localStorage.
 */


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
const LIST = "scroll-edge-fade edge-fade-sidebar scroll-gutter flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto ps-2 pt-1 pb-2";

export function AppSidebar({
  rows,
  projects,
  active,
  home,
  offline,
  onOpen,
  onNewSession,
  onNewChat,
  foot,
  storeKey = "sidebar",
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
  /** The New chat row and the strip's: Home in no project [D421]. */
  onNewChat: () => void;
  /** Given the strip's Archived icon, which only the sidebar has the rows for. */
  foot?: (archived: ReactNode) => ReactNode;
  /** Where its view is kept; the gallery's demos keep theirs apart. */
  storeKey?: string;
}) {
  const [grouping, setGrouping] = useStored<Grouping>(`${storeKey}.grouping`, "project");
  const [folded, setFolded] = useStored<string[]>(`${storeKey}.folded`, []);
  const [renaming, setRenaming] = useState<SessionRow | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const previousRows = useRef(rows);
  useEffect(() => {
    // Deleting the open conversation returned Home in the old app.
    if (active && rows && previousRows.current?.some((row) => row.id === active) && !rows.some((row) => row.id === active)) onNewSession();
    previousRows.current = rows;
  }, [rows, active, onNewSession]);
  const isOpen = (key: string) => !folded.includes(key);
  const setOpen = (key: string, open: boolean) => setFolded(open ? folded.filter((each) => each !== key) : [...folded, key]);
  // Archived rows dock below the list; the rest are the live ones [D198].
  // A worker is its parent's, in its Workers tab, not a row of its own [D3012]; a Brigade's session is a row [D189].
  const sessions = useMemo(() => rows?.filter((row) => !((row as { worker?: unknown }).worker && !row.boss) && !(row as { noteChat?: boolean }).noteChat), [rows]);
  const { live: shown, archived } = useArchiveSplit(useShown(sessions));
  const show = useShowFilter(storeKey, projects);
  const kept = shown?.filter(show.keeps);
  const picks = new Set(usePicked().map((each) => each.id));
  const projectOf = new Map(projects.map((project) => [project.id, project]));
  // Pinned rows sit in Pinned only, the latest pin first; the rest by last send [D185].
  const pinned = kept?.filter((each) => each.pinned).toSorted((a, b) => b.pinned! - a.pinned! || byLastSend(a, b)) ?? [];
  const rest = underSources(kept?.filter((each) => !each.pinned).toSorted(byLastSend), (id) => isOpen(`brigade:${id}`));
  const forked = new Set(rest?.filter((each) => each.forkOf && rest.some((source) => source.id === each.forkOf)).map((each) => each.id));
  const homeless = rest?.filter(show.homeless) ?? [];
  const byName = projects.filter((project) => !show.hiddenProjects.has(project.id)).toSorted((a, b) => a.name.localeCompare(b.name));
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
  // The open session's keys work even with its project left out by View.
  const activeRow = shown?.find((each) => each.id === active);
  useArchiveKeys(shown ?? [], active, onNewSession);

  // Unfolds what holds a row, then brings it into view.
  const reveal = (id: string) => {
    const keys = sections.find(([, each]) => each.some((row) => row.id === id))?.[0] ?? [];
    if (keys.some((key) => !isOpen(key))) setFolded(folded.filter((key) => !keys.includes(key)));
    requestAnimationFrame(() => list.current?.querySelector(`[data-row-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }));
  };
  // Opening a session unfolds what holds its row, as the old app's openConversation did.
  useEffect(() => {
    if (activeRow) reveal(activeRow.id);
  }, [activeRow?.id]);
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
      if (event.repeat) return;
      const action = Object.entries({
        "next-waiting": nextNeedingYou,
        pin: activeRow && (() => pin(activeRow, !activeRow.pinned)),
        rename: activeRow && (() => setRenaming(activeRow)),
      }).find(([id]) => matches(event, id))?.[1];
      if (!action) return;
      event.preventDefault();
      action();
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  });

  // A Brigade folds its sessions under it; folded, its mark is the most pressing of theirs and its own [D189].
  const foldOf = (each: SessionRow) => {
    const subs = kept?.filter((sub) => sub.boss === each.id) ?? [];
    const key = `brigade:${each.id}`;
    return subs.length === 0 ? undefined : { open: isOpen(key), toggle: () => setOpen(key, !isOpen(key)), marks: subs.map((sub) => sub.mark) };
  };
  const row = (each: SessionRow, layout: { badged?: boolean; nested?: boolean }) => (
    <SessionRowItem
      key={each.id}
      row={each}
      project={each.project === null ? undefined : projectOf.get(each.project)}
      tone={projects.findIndex((project) => project.id === each.project)}
      active={each.id === active}
      offline={offline}
      onOpen={onOpen}
      picked={picks.has(each.id)}
      onClick={(event) => clickRow(event, each, order, active, onOpen)}
      onRename={setRenaming}
      forked={forked.has(each.id)}
      sub={Boolean(each.boss && rest?.some((boss) => boss.id === each.boss))}
      fold={foldOf(each)}
      {...layout}
    />
  );
  const view = <ViewTrigger projects={projects} show={show} />;
  const listed = { active, offline, onOpen };
  // Add project shows a project already added here: grouped by project, unfolded, in view [D165].
  useEffect(() => {
    setShowProject((id, group) => {
      if (group) setGrouping("project");
      show.setHiddenProjects([...show.hiddenProjects].filter((each) => each !== id));
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
    <SidebarPanel
      strip={
        <Strip onNewChat={onNewChat}>
          {pinned.length > 0 && <PinnedFlyout pinned={pinned} {...listed} />}
          <ProjectsFlyout projects={byName} sessions={rest ?? []} {...listed} />
          <ChatsFlyout chats={homeless} {...listed} />
        </Strip>
      }
      foot={foot?.(archived.length > 0 && <ArchivedFlyout archived={archived} {...listed} />)}
    >
      <ViewMenu grouping={grouping} onGrouping={setGrouping} projects={projects} rows={shown ?? []} show={show}>
        {/* The card's top [new-design]: the traffic lights' row (the History pill sits at its end), the name, New chat, Search. */}
        <div className="flex shrink-0 flex-col gap-3 px-2.5 pt-3 pb-2.5 win:pt-1.25">
          {/* Windows has no traffic lights: the name heads the row the History pill ends. */}
          <div className="h-7.5 win:hidden" />
          <h1 className="flex h-7.5 items-center gap-2 ps-1.5 text-nav-title font-semibold">
            <BrigadierMark className="size-5 shrink-0" />
            Brigadier
          </h1>
          <NavRow data-active={home || undefined} className="ps-1.5" onClick={onNewChat}>
            <ComposeEditSquare />
            New chat
          </NavRow>
          <div className="flex h-7.5 items-center gap-1.5 rounded-capsule bg-control ps-2.5 pe-1">
            <button type="button" aria-label="Search" title={`Search ${keysOf("search")[0]}`} onClick={openSearch} className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 self-stretch text-label text-placeholder outline-none focus-visible:focus-ring">
              <MagnifyingGlassSmSearch className="size-icon-sm shrink-0" />
              Search
            </button>
            {view}
          </div>
        </div>
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
                {/* One section for both layouts: the View button in its header stays mounted, so an open menu keeps its place. */}
                <NavSection
                  title={grouping === "none" ? "Open" : "Projects"}
                  open={isOpen(grouping === "none" ? "open" : "projects")}
                  onOpenChange={(open) => setOpen(grouping === "none" ? "open" : "projects", open)}
                  actions={
                    grouping === "project" && (
                      <Tooltip>
                        <TooltipTrigger render={<RowAction header aria-label="Add project" onClick={() => openAddProject()} />}>
                          <Plus />
                        </TooltipTrigger>
                        <TooltipContent side="bottom">Add project</TooltipContent>
                      </Tooltip>
                    )
                  }
                >
                  {grouping === "none" ? (
                    <NavList className="gap-1">
                      {rest.map((each) => row(each, { badged: true }))}
                      {pinned.length === 0 && rest.length === 0 && (!show.all || archived?.length === 0) && <EmptyState as="li" title={show.all ? "Sessions you start appear here." : "Nothing here with this view."} />}
                    </NavList>
                  ) : (
                    <NavList>
                      {byName.map((project) => (
                        <ProjectRow
                          key={project.id}
                          project={project}
                          open={isOpen(project.id)}
                          onOpenChange={(open) => setOpen(project.id, open)}
                        >
                          {rest.filter((each) => each.project === project.id).map((each) => row(each, { nested: true }))}
                        </ProjectRow>
                      ))}
                      {projects.length === 0 && (
                        <EmptyState
                          as="li"
                          title={<NoProjects onAdd={() => openAddProject()} />}
                        />
                      )}
                    </NavList>
                  )}
                </NavSection>
                {/* Sessions with no project (made before projects were records) [D224]. */}
                {grouping === "project" && homeless.length > 0 && (
                  <NavSection title="Chats" open={isOpen("none")} onOpenChange={(open) => setOpen("none", open)}>
                    <NavList>{homeless.map((each) => row(each, {}))}</NavList>
                  </NavSection>
                )}
              </>
            )}
          </div>
          <NeedYouPill list={list} ids={attention.map((each) => each.id)} waiting={attention.some((each) => each.mark === "needs")} />
        </div>
      </ViewMenu>
      <ArchiveAsk />
      <ArchivedSection rows={archived} projects={projects} active={active} offline={offline} onOpen={onOpen} storeKey={storeKey} />
      <RenameDialog row={renaming} onClose={() => setRenaming(null)} onRename={(title, branch) => renaming && rename(renaming, title, branch)} />
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

/** A project and its sessions, folding away under it; "No sessions yet" with none. Hovered, its menu and New session [D171, D212]. */
function ProjectRow({
  project,
  open,
  onOpenChange,
  children,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode[];
}) {
  const label = useRef<HTMLSpanElement>(null);
  // Its name in a tip only when the row cuts it.
  const [cut, setCut] = useState(false);
  const measure = () => setCut((label.current?.scrollWidth ?? 0) > (label.current?.clientWidth ?? 0));
  return (
    <li data-project-id={project.id} className="flex flex-col">
      <div className="group/row relative">
        <Tooltip>
          <TooltipTrigger delay={CARD_DELAY_MS} render={<NavRow aria-expanded={open} className="pe-16" onPointerEnter={measure} onFocus={measure} onClick={() => onOpenChange(!open)} />}>
            {open ? <FolderOpen /> : <Folder />}
            <span ref={label} className="min-w-0 flex-1 truncate">{project.name}</span>
          </TooltipTrigger>
          {cut && <TooltipContent side="right" className="wrap-anywhere">{project.name}</TooltipContent>}
        </Tooltip>
        <RowActionsSlot>
          <DropdownMenu modal={false}>
            <Tooltip>
              <TooltipTrigger render={<DropdownMenuTrigger render={<RowAction aria-label={`Actions for ${project.name}`} />} />}>
                <DotsHorizontal />
              </TooltipTrigger>
              <TooltipContent side="bottom">Project actions</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start">
              <ProjectMenuItems project={project} />
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger render={<RowAction aria-label={`New session in ${project.name}`} onClick={() => newSessionIn(project.id)} />}>
              <ComposeEditSquare />
            </TooltipTrigger>
            <TooltipContent side="bottom">New session</TooltipContent>
          </Tooltip>
        </RowActionsSlot>
      </div>
      <NavFold open={open}>
        <NavList className="pt-px pb-2">
          {children}
          {children.length === 0 && <EmptyState as="li" className="ps-8" title="No sessions yet" />}
        </NavList>
      </NavFold>
    </li>
  );
}

/**
 * The collapsed rail [new-design]: under the traffic lights the logo (resting on it peeks the panel), New chat and
 * Search, a rule, then the lists (`children`). The sidebar toggle is the History pill's, never here.
 */
function Strip({ onNewChat, children }: { onNewChat: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 pt-11.25 win:pt-1.25">
      <div data-sidebar-peek-trigger className="flex h-7.5 w-9 items-center justify-center text-foreground">
        <BrigadierMark className="size-6" />
      </div>
      <div className="flex flex-col items-center gap-0.5">
        <TooltipIconButton tooltip="New chat" look="strip" side="right" onClick={onNewChat}>
          <ComposeEditSquare />
        </TooltipIconButton>
        <TooltipIconButton tooltip="Search" shortcut={keysOf("search")[0]} look="strip" side="right" onClick={openSearch}>
          <MagnifyingGlassSmSearch />
        </TooltipIconButton>
      </div>
      <span aria-hidden className="h-px w-6 bg-divider" />
      <div className="flex flex-col items-center gap-0.5">{children}</div>
    </div>
  );
}

/** Each fork right under its source, the list's order otherwise [D48]. */
function underSources(list: SessionRow[] | undefined, open: (id: string) => boolean): SessionRow[] | undefined {
  if (!list) return list;
  const here = new Set(list.map((each) => each.id));
  // A Brigade's sub-sessions sit under it, oldest first, folding with it [D189].
  const subs = (each: SessionRow) => (each.brigade && open(each.id) ? list.filter((sub) => sub.boss === each.id).toSorted((a, b) => a.sent - b.sent) : []);
  const under = (each: SessionRow): SessionRow[] => [each, ...subs(each).flatMap(under), ...list.filter((fork) => fork.forkOf === each.id).flatMap(under)];
  return list.filter((each) => !(each.forkOf && here.has(each.forkOf)) && !(each.boss && here.has(each.boss))).flatMap(under);
}
