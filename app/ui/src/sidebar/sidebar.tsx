import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "../components/empty-state";
import { TooltipIconButton } from "../components/icon-button";
import { NavList, NavRow, NavSection } from "../components/nav";
import { RowAction } from "../components/row-action";
import { SidebarPanel } from "../components/sidebar";
import { Skeleton } from "../components/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ComposeEditSquare, MagnifyingGlassSearch, Plus } from "../icons";
import { openSearch } from "../palette/palette";
import { ArchiveAsk, clickRow, useArchiveKeys, useArchiveSplit, usePicked } from "../sessions/archive";
import { ArchivedSection, DeleteAsk } from "../sessions/archived";
import { LabelAsk } from "./labels";
import type { Project } from "../projects/projects";
import { openAddProject, setShowProject } from "../projects/store";
import { keysOf, matches } from "../shortcuts";
import { pin, rename, useShown } from "./actions";
import { ArchivedFlyout, attentionOf, ChatsFlyout, NoProjects, ProjectSquare, SessionSquare } from "./flyout";
import { RenameDialog } from "./menu";
import { ProjectAsk, ProjectRow } from "./project-row";
import { SessionRowItem, SidebarMark } from "./row";
import { type Grouping, type Sort, useShowFilter, ViewMenu, ViewTrigger } from "./view";
import type { SessionRow } from "./words";

/*
 * The app's sidebar [D22–D33 D59–D66]: its name with View and ⌘K's search, New chat, then what View's Organize
 * sidebar picks [D806]. By projects: Pinned projects, Projects by name, each opening and closing its sessions under it
 * [D30], and Chats, the sessions in no project. By sessions: Pinned sessions, Recents, every live one with its project's
 * badge [D32], and Archived [D803]. Rows go by the user's last send, newest first, so a row never moves while it works; or,
 * picked in View, by anyone's last activity [D810]. Mode, order and folds are this window's view, kept in localStorage; a
 * pin is Rust's.
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
const LIST = "scroll-edge-fade edge-fade-sidebar scroll-gutter flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto ps-2 pb-2";

export function AppSidebar({
  rows,
  projects,
  active,
  page = null,
  offline,
  onOpen,
  onNewSession,
  onNewChat,
  rail,
  storeKey = "sidebar",
}: {
  /** undefined until the first list arrives. */
  rows: SessionRow[] | undefined;
  /** Oldest first: a project's place here picks its badge's colour. */
  projects: Project[];
  /** The open session's id. */
  active: string | null;
  /** The project whose page shows [D780]. */
  page?: string | null;
  offline: boolean;
  onOpen: (id: string) => void;
  onNewSession: () => void;
  /** The New chat button: Home in no project [D421]. */
  onNewChat: () => void;
  /** The strip, given its squares and lists, which only the sidebar has the rows for. */
  rail?: (squares: ReactNode) => ReactNode;
  /** Where its view is kept; the gallery's demos keep theirs apart. */
  storeKey?: string;
}) {
  const [grouping, setGrouping] = useStored<Grouping>(`${storeKey}.grouping`, "project");
  const [sort, setSort] = useStored<Sort>(`${storeKey}.sort`, "sent");
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
  // A worker is its parent's, in its Workers tab, not a row of its own [D3012]; a Brigade's session is a plain row [D189 D63].
  const sessions = useMemo(() => rows?.filter((row) => !((row as { worker?: unknown }).worker && !row.boss) && !(row as { noteChat?: boolean }).noteChat), [rows]);
  const { live: shown, archived } = useArchiveSplit(useShown(sessions));
  const show = useShowFilter(storeKey, projects);
  const kept = shown?.filter(show.keeps);
  const picks = new Set(usePicked().map((each) => each.id));
  const projectOf = new Map(projects.map((project) => [project.id, project]));
  // Pinned rows sit in Pinned only, the latest pin first; the rest by last send, or by last activity [D185, D655].
  const bySort = sort === "activity" ? (a: SessionRow, b: SessionRow) => (b.updated ?? b.sent) - (a.updated ?? a.sent) || byLastSend(a, b) : byLastSend;
  // By projects pins projects, not sessions [D808].
  const pinsSessions = grouping === "none";
  const pinned = (pinsSessions && kept?.filter((each) => each.pinned).toSorted((a, b) => b.pinned! - a.pinned! || bySort(a, b))) || [];
  const rest = kept?.filter((each) => !(pinsSessions && each.pinned)).toSorted(bySort);
  const homeless = rest?.filter(show.homeless) ?? [];
  const byName = projects.filter((project) => !show.hiddenProjects.has(project.id)).toSorted((a, b) => a.name.localeCompare(b.name));
  const pinnedProjects = byName.filter((project) => project.pinned).toSorted((a, b) => b.pinned! - a.pinned!);
  const unpinnedProjects = byName.filter((project) => !project.pinned);
  const chatsIn = (project: string) => rest?.filter((each) => each.project === project) ?? [];
  // From every live session in it.
  const attentionIn = (project: string) => attentionOf(chatsIn(project), active);
  // Each section's rows top to bottom, keyed by what folds them: the order a picked range and ⌥⌘A go by.
  const sections: [string[], SessionRow[]][] =
    grouping === "none"
      ? [
          [["pinned"], pinned],
          [["open"], rest ?? []],
        ]
      : [
          ...pinnedProjects.map((project): [string[], SessionRow[]] => [["pinned", `project:${project.id}`], chatsIn(project.id)]),
          ...unpinnedProjects.map((project): [string[], SessionRow[]] => [["projects", `project:${project.id}`], chatsIn(project.id)]),
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
        pin: pinsSessions && activeRow && (() => pin(activeRow, !activeRow.pinned)),
        rename: activeRow && (() => setRenaming(activeRow)),
      }).find(([id]) => matches(event, id))?.[1];
      if (!action) return;
      event.preventDefault();
      action();
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  });

  const row = (each: SessionRow, layout: { badged?: boolean; indent?: boolean }) => (
    <SessionRowItem
      key={each.id}
      row={each}
      project={each.project === null ? undefined : projectOf.get(each.project)}
      tone={projects.findIndex((project) => project.id === each.project)}
      active={each.id === active}
      canPin={pinsSessions}
      offline={offline}
      onOpen={onOpen}
      picked={picks.has(each.id)}
      onClick={(event) => clickRow(event, each, order, active, onOpen)}
      onRename={setRenaming}
      {...layout}
    />
  );
  const listed = { active, offline, onOpen };
  const projectRow = (project: Project) => {
    const key = `project:${project.id}`;
    const chats = chatsIn(project.id);
    return (
      <ProjectRow key={project.id} project={project} tone={projects.indexOf(project)} current={page === project.id} open={isOpen(key)} onToggle={() => setOpen(key, !isOpen(key))} attention={attentionIn(project.id)} chats={chats}>
        {chats.map((each) => row(each, { indent: true }))}
      </ProjectRow>
    );
  };
  // Add project shows a project already added here: by projects, unfolded, in view [D165].
  useEffect(() => {
    setShowProject((id, group) => {
      if (group) setGrouping("project");
      show.setHiddenProjects([...show.hiddenProjects].filter((each) => each !== id));
      setFolded(folded.filter((key) => key !== "projects" && key !== "pinned"));
      requestAnimationFrame(() => document.querySelector(`[data-project-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }));
    });
  });

  return (
    <SidebarPanel
      rail={rail?.(
        <>
          {pinsSessions
            ? order.map((each) => (
                <SessionSquare
                  key={each.id}
                  row={each}
                  project={each.project === null ? undefined : projectOf.get(each.project)}
                  tone={projects.findIndex((project) => project.id === each.project)}
                  active={each.id === active}
                  attention={attentionOf([each], active)}
                  onOpen={onOpen}
                />
              ))
            : [...pinnedProjects, ...unpinnedProjects].map((project) => (
                <ProjectSquare key={project.id} project={project} tone={projects.indexOf(project)} current={page === project.id} attention={attentionIn(project.id)} />
              ))}
          {!pinsSessions && !show.hideChats && <ChatsFlyout chats={homeless} {...listed} />}
          {pinsSessions && archived.length > 0 && <ArchivedFlyout archived={archived} {...listed} />}
        </>,
      )}
    >
      {/* The header under the titlebar row: the name, no logo or chevron, then View and ⌘K's search [D22 D23 D24 D59]. */}
      <ViewMenu grouping={grouping} onGrouping={setGrouping} sort={sort} onSort={setSort} projects={projects} rows={shown ?? []} show={show}>
        <div className="flex h-tab-bar shrink-0 items-center gap-1 ps-4 pe-3">
          <h1 className="min-w-0 flex-1 truncate text-nav-title font-semibold">Brigadier</h1>
          <ViewTrigger projects={projects} show={show} />
          <TooltipIconButton tooltip="Search" shortcut={keysOf("search")[0]} look="head" side="bottom" onClick={openSearch}>
            <MagnifyingGlassSearch />
          </TooltipIconButton>
        </div>
      </ViewMenu>
      <div ref={list} className={LIST}>
        {/* New chat, the first row [D25], never lit: Home isn't a place in the list. */}
        <NavList>
          <li>
            <NavRow onClick={onNewChat}>
              <ComposeEditSquare />
              New chat
            </NavRow>
          </li>
        </NavList>
        {rest === undefined ? (
          <Loading />
        ) : (
          <>
            {(pinned.length > 0 || (!pinsSessions && pinnedProjects.length > 0)) && (
              <NavSection title="Pinned" open={isOpen("pinned")} onOpenChange={(open) => setOpen("pinned", open)}>
                <NavList>{pinsSessions ? pinned.map((each) => row(each, { badged: true })) : pinnedProjects.map(projectRow)}</NavList>
              </NavSection>
            )}
            {grouping === "none" ? (
              <NavSection
                title="Recents"
                open={isOpen("open")}
                onOpenChange={(open) => setOpen("open", open)}
                steadyEnd={!isOpen("open") && attentionOf(rest, active) && <SidebarMark mark="unread" label="A session needs your attention" />}
              >
                <NavList>
                  {rest.map((each) => row(each, { badged: true }))}
                  {pinned.length === 0 && rest.length === 0 && (!show.all || archived?.length === 0) && <EmptyState as="li" title={show.all ? "Sessions you start appear here." : "Nothing here with this view."} />}
                </NavList>
              </NavSection>
            ) : (
              <NavSection
                title="Projects"
                open={isOpen("projects")}
                onOpenChange={(open) => setOpen("projects", open)}
                actions={
                  <Tooltip>
                    <TooltipTrigger render={<RowAction header aria-label="Add project" onClick={() => openAddProject()} />}>
                      <Plus />
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Add project</TooltipContent>
                  </Tooltip>
                }
              >
                <NavList>
                  {unpinnedProjects.map(projectRow)}
                  {projects.length === 0 && <EmptyState as="li" title={<NoProjects onAdd={() => openAddProject()} />} />}
                </NavList>
              </NavSection>
            )}
            {/* Sessions with no project; shown while ticked in View, empty or not [D224, D655, D812]. */}
            {grouping === "project" && !show.hideChats && (
              <NavSection
                title="Chats"
                open={isOpen("none")}
                onOpenChange={(open) => setOpen("none", open)}
                actions={
                  <Tooltip>
                    <TooltipTrigger render={<RowAction header aria-label="New chat" onClick={onNewChat} />}>
                      <Plus />
                    </TooltipTrigger>
                    <TooltipContent side="bottom">New chat</TooltipContent>
                  </Tooltip>
                }
              >
                <NavList>
                  {homeless.map((each) => row(each, {}))}
                  {homeless.length === 0 && <EmptyState as="li" title="No chats yet" />}
                </NavList>
              </NavSection>
            )}
          </>
        )}
      </div>
      <ArchiveAsk />
      <DeleteAsk />
      <LabelAsk />
      <ProjectAsk />
      {pinsSessions && <ArchivedSection rows={archived} projects={projects} active={active} offline={offline} onOpen={onOpen} storeKey={storeKey} />}
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
