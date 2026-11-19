import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "../components/empty-state";
import { TooltipIconButton } from "../components/icon-button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { NavList, NavRow, NavSection } from "../components/nav";
import { RowAction, RowActionsSlot } from "../components/row-action";
import { SidebarPanel } from "../components/sidebar";
import { Skeleton } from "../components/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ComposeEditSquare, DotsHorizontal, MagnifyingGlassSmSearch, Pin, Plus, Unpin } from "../icons";
import { BrigadierMark } from "../onboarding/mark";
import { openSearch } from "../palette/palette";
import { newSession } from "../home/start";
import { openProject } from "../projects/page";
import { ArchiveAsk, clickRow, useArchiveKeys, useArchiveSplit, usePicked } from "../sessions/archive";
import { ArchivedSection } from "../sessions/archived";
import { pinProject, type Project } from "../projects/projects";
import { openAddProject, setShowProject } from "../projects/store";
import { keysOf, matches } from "../shortcuts";
import { pin, rename, useShown } from "./actions";
import { ArchivedFlyout, attentionOf, ChatsFlyout, NoProjects, ProjectSquare, SessionSquare, Squares } from "./flyout";
import { RenameDialog } from "./menu";
import { SearchResults, useSidebarSearch } from "./search";
import { NeedYouPill } from "./pill";
import { CARD_DELAY_MS, ProjectBadge, RowMark, SessionRowItem } from "./row";
import { type Grouping, type Sort, useShowFilter, ViewMenu, ViewTrigger } from "./view";
import type { SessionRow } from "./words";

/*
 * The app's sidebar [D173, D174], its search field, Add project and New chat on one row in both modes [D846], picked in View's Organize sidebar [D806]. By projects:
 * Pinned projects, Projects by name, each opening its page, and Chats, the sessions in no project; no other
 * session and nothing archived shows [D808, D809, D812]. By sessions: Pinned sessions, Open, every
 * project's and none, each with its project's badge, and Archived [D803]. Rows go by the user's last send,
 * newest first, so a row never moves while it works; or, picked in View, by anyone's last activity [D810].
 * Mode, order and folds are this window's view, kept in localStorage; a pin is Rust's.
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
  page = null,
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
  /** Oldest first: a project's place here picks its badge's colour. */
  projects: Project[];
  /** The open session's id. */
  active: string | null;
  /** The project whose page shows [D780]. */
  page?: string | null;
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
  // A worker is its parent's, in its Workers tab, not a row of its own [D3012]; a Brigade's session is a row [D189].
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
  const rest = underSources(kept?.filter((each) => !(pinsSessions && each.pinned)).toSorted(bySort), (id) => isOpen(`brigade:${id}`));
  const forked = new Set(rest?.filter((each) => each.forkOf && rest.some((source) => source.id === each.forkOf)).map((each) => each.id));
  const homeless = rest?.filter(show.homeless) ?? [];
  const byName = projects.filter((project) => !show.hiddenProjects.has(project.id)).toSorted((a, b) => a.name.localeCompare(b.name));
  // Typing searches in the list's place; Archived and the pill wait until the field is empty [D846].
  const search = useSidebarSearch(byName, kept ?? [], [...(shown ?? []), ...archived], offline, onOpen);
  const pinnedProjects = byName.filter((project) => project.pinned).toSorted((a, b) => b.pinned! - a.pinned!);
  const unpinnedProjects = byName.filter((project) => !project.pinned);
  // From every live session, a folded Brigade's too.
  const attentionIn = (project: string) => attentionOf(kept?.filter((each) => each.project === project) ?? [], active);
  // Its sessions not archived [D844].
  const countIn = (project: string) => shown?.filter((each) => each.project === project).length ?? 0;
  // Each section's rows top to bottom, keyed by what folds them: the order a picked range and the pill count.
  const sections: [string[], SessionRow[]][] =
    grouping === "none"
      ? [
          [["pinned"], pinned],
          [["open"], rest ?? []],
        ]
      : [[["none"], homeless]];
  const order = sections.flatMap(([, each]) => each);
  // ⌥⌘A goes through every live session, By projects too, where most aren't rows.
  const cycle = pinsSessions ? order : (rest ?? []);
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
    const at = cycle.findIndex((each) => each.id === active);
    const next = [...cycle.slice(at + 1), ...cycle.slice(0, Math.max(at, 0))].find((each) => each.mark === "needs");
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
      canPin={pinsSessions}
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
  const projectRow = (project: Project) => (
    <ProjectRow key={project.id} project={project} tone={projects.indexOf(project)} current={page === project.id} attention={attentionIn(project.id)} count={countIn(project.id)} />
  );
  // Add project shows a project already added here: by projects, unfolded, in view [D165].
  useEffect(() => {
    setShowProject((id, group) => {
      if (group) setGrouping("project");
      show.setHiddenProjects([...show.hiddenProjects].filter((each) => each !== id));
      setFolded(folded.filter((key) => key !== "projects" && key !== "pinned"));
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
          {pinsSessions
            ? order.map((each) => (
                <SessionSquare
                  key={each.id}
                  row={each}
                  project={each.project === null ? undefined : projectOf.get(each.project)}
                  tone={projects.findIndex((project) => project.id === each.project)}
                  active={each.id === active}
                  attention={attentionOf(kept?.filter((row) => row.id === each.id || (row.boss === each.id && !isOpen(`brigade:${each.id}`))) ?? [], active)}
                  onOpen={onOpen}
                />
              ))
            : [...pinnedProjects, ...unpinnedProjects].map((project) => (
                <ProjectSquare key={project.id} project={project} tone={projects.indexOf(project)} current={page === project.id} attention={attentionIn(project.id)} />
              ))}
          {!pinsSessions && !show.hideChats && <ChatsFlyout chats={homeless} {...listed} />}
        </Strip>
      }
      foot={foot?.(pinsSessions && archived.length > 0 && <ArchivedFlyout archived={archived} {...listed} />)}
    >
      {/* The card's top, under the tab bar [D48]: the name, then the search field with View in it, Add project and New chat [D846]; ⌘K's palette stays. */}
      <div className="flex shrink-0 px-2.5 pt-3 pb-1.5">
        <h1 className="flex h-7.5 min-w-0 flex-1 items-center gap-2 overflow-clip ps-1.5 text-nav-title font-semibold whitespace-nowrap">
          <button type="button" aria-label="Home" className="shrink-0 cursor-pointer rounded-xs focus-visible:focus-ring" onClick={onNewChat}>
            <BrigadierMark className="block size-icon-mark" />
          </button>
          <span className="min-w-0 truncate">Brigadier</span>
        </h1>
      </div>
      <ViewMenu grouping={grouping} onGrouping={setGrouping} sort={sort} onSort={setSort} projects={projects} rows={shown ?? []} show={show}>
        <div className="flex shrink-0 items-center gap-1 px-2.5 pb-2.5">
          <div className="flex h-7.5 min-w-0 flex-1 items-center gap-1.5 rounded-capsule bg-control ps-2.5 pe-1 has-focus-visible:focus-ring">
            <MagnifyingGlassSmSearch className="size-icon-sm shrink-0 text-placeholder" />
            <input
              aria-label="Search"
              placeholder="Search"
              value={search.q}
              onChange={(event) => search.setQ(event.target.value)}
              onKeyDown={search.onKeyDown}
              className="min-w-0 flex-1 self-stretch bg-transparent text-label text-foreground outline-none placeholder:text-placeholder"
            />
            {view}
          </div>
          <TooltipIconButton tooltip="Add project" look="strip" side="bottom" onClick={() => openAddProject()}>
            <Plus />
          </TooltipIconButton>
          <TooltipIconButton tooltip="New chat" look="strip" side="bottom" pressed={home} onClick={onNewChat}>
            <ComposeEditSquare />
          </TooltipIconButton>
        </div>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={list} className={LIST}>
            {rest === undefined ? (
              <Loading />
            ) : search.query ? (
              <SearchResults search={search} projects={projects} offline={offline} project={projectRow} session={(each) => row(each, { badged: true })} />
            ) : (
              <>
                {(pinned.length > 0 || (!pinsSessions && pinnedProjects.length > 0)) && (
                  <NavSection title="Pinned" open={isOpen("pinned")} onOpenChange={(open) => setOpen("pinned", open)}>
                    <NavList className="gap-1">{pinsSessions ? pinned.map((each) => row(each, { badged: true })) : pinnedProjects.map(projectRow)}</NavList>
                  </NavSection>
                )}
                <NavSection
                  title={grouping === "none" ? "Open" : "Projects"}
                  open={isOpen(grouping === "none" ? "open" : "projects")}
                  onOpenChange={(open) => setOpen(grouping === "none" ? "open" : "projects", open)}
                >
                  {grouping === "none" ? (
                    <NavList className="gap-1">
                      {rest.map((each) => row(each, { badged: true }))}
                      {pinned.length === 0 && rest.length === 0 && (!show.all || archived?.length === 0) && <EmptyState as="li" title={show.all ? "Sessions you start appear here." : "Nothing here with this view."} />}
                    </NavList>
                  ) : (
                    <NavList className="gap-1">
                      {unpinnedProjects.map(projectRow)}
                      {projects.length === 0 && (
                        <EmptyState
                          as="li"
                          title={<NoProjects onAdd={() => openAddProject()} />}
                        />
                      )}
                    </NavList>
                  )}
                </NavSection>
                {/* Sessions with no project, the one place By projects lists sessions; shown while ticked in View, empty or not [D224, D655, D812]. */}
                {grouping === "project" && !show.hideChats && (
                  <NavSection title="Chats" open={isOpen("none")} onOpenChange={(open) => setOpen("none", open)}>
                    <NavList>
                      {homeless.map((each) => row(each, {}))}
                      {homeless.length === 0 && <EmptyState as="li" title="No chats yet" />}
                    </NavList>
                  </NavSection>
                )}
              </>
            )}
          </div>
          {!search.query && <NeedYouPill list={list} ids={attention.map((each) => each.id)} waiting={attention.some((each) => each.mark === "needs")} />}
        </div>
      </ViewMenu>
      <ArchiveAsk />
      {pinsSessions && !search.query && <ArchivedSection rows={archived} projects={projects} active={active} offline={offline} onOpen={onOpen} storeKey={storeKey} />}
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

/**
 * A project: a click opens its page, where its sessions and settings are; hovered, New session starts one and ⋯ pins
 * it, as a right-click does. Its count and blue mark are its sessions' [D171, D212, D780, D808, D844].
 */
function ProjectRow({ project, tone, current, attention, count }: { project: Project; tone: number; current: boolean; attention: boolean; count: number }) {
  const label = useRef<HTMLSpanElement>(null);
  // Its name in a tip only when the row cuts it.
  const [cut, setCut] = useState(false);
  const measure = () => setCut((label.current?.scrollWidth ?? 0) > (label.current?.clientWidth ?? 0));
  const items = (
    <DropdownMenuItem onClick={() => pinProject(project, !project.pinned)}>
      {project.pinned ? <Unpin /> : <Pin />}
      {project.pinned ? "Unpin" : "Pin"}
    </DropdownMenuItem>
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<li data-project-id={project.id} className="group/row relative" />}>
        <Tooltip>
          <TooltipTrigger
            delay={CARD_DELAY_MS}
            render={<NavRow aria-current={current ? "page" : undefined} className="pe-1.5 group-hover/row:pe-16 group-has-focus-visible/row:pe-16 group-has-aria-expanded/row:pe-16" onPointerEnter={measure} onFocus={measure} onClick={() => openProject(project.id)} />}
          >
            {/* Its logo, else its initials, as View's menu shows it [D650]. */}
            <ProjectBadge id={project.id} name={project.name} tone={tone} />
            <span ref={label} className="min-w-0 flex-1 truncate">{project.name}</span>
            {/* One blue mark for every kind, then how many sessions it holds [D844]. */}
            <span className="flex shrink-0 items-center gap-1.5 group-hover/row:hidden group-has-focus-visible/row:hidden group-has-aria-expanded/row:hidden">
              {attention && <RowMark mark="needs" label="A session needs your attention" />}
              <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
            </span>
          </TooltipTrigger>
          {cut && <TooltipContent side="right" className="wrap-anywhere">{project.name}</TooltipContent>}
        </Tooltip>
        <RowActionsSlot>
          <Tooltip>
            <TooltipTrigger render={<RowAction aria-label={`New session in ${project.name}`} onClick={() => newSession(project.id)} />}>
              <ComposeEditSquare />
            </TooltipTrigger>
            <TooltipContent side="bottom">New session</TooltipContent>
          </Tooltip>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger render={<RowAction aria-label={`Actions for ${project.name}`} />}>
              <DotsHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">{items}</DropdownMenuContent>
          </DropdownMenu>
        </RowActionsSlot>
      </ContextMenuTrigger>
      <ContextMenuContent>{items}</ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The collapsed rail [new-design]: the logo, New chat and Search, a rule, then the squares and Chats (`children`),
 * scrolling. The sidebar toggle is the History pill's. A click on the logo goes Home [D66, D69, D803].
 */
function Strip({ onNewChat, children }: { onNewChat: () => void; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center gap-3 pt-2.75">
      <TooltipIconButton tooltip="Home" tip={false} look="strip" onClick={onNewChat}>
        <BrigadierMark className="size-icon-mark" />
      </TooltipIconButton>
      <div className="flex flex-col items-center gap-0.5">
        <TooltipIconButton tooltip="New chat" look="strip" side="right" onClick={onNewChat}>
          <ComposeEditSquare />
        </TooltipIconButton>
        <TooltipIconButton tooltip="Search" shortcut={keysOf("search")[0]} look="strip" side="right" onClick={openSearch}>
          <MagnifyingGlassSmSearch />
        </TooltipIconButton>
      </div>
      <span aria-hidden className="h-px w-6 shrink-0 bg-divider" />
      <Squares>{children}</Squares>
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
