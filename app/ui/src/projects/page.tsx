import { Tabs } from "@base-ui/react/tabs";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { Button } from "../components/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../components/context-menu";
import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/menu";
import { RowAction } from "../components/row-action";
import { Segment, SegmentedRoot } from "../components/segmented";
import { useDaemon } from "../daemon";
import { newSession, setHomeDraft } from "../home/start";
import { ArrowUpRight, BranchAlt, ChevronDown, DotsHorizontal, Folder, Plus } from "../icons";
import { HostOf } from "../landing/host";
import { openPr } from "../panel/open";
import { HOME, setHomeTabs } from "../shell/tab-store";
import { rename, useShown } from "../sidebar/actions";
import { useSecond } from "../thread/words";
import { CHIP, PrList } from "../landing/pr-list";
import { prList } from "../landing/pr-chip";
import { ago } from "../landing/pr-words";
import { BrigadeGlyph } from "../sessions/brigade";
import { SearchField } from "../settings/archived-toolbar";
import { RenameDialog, RowMenuItems } from "../sidebar/menu";
import { RowMark } from "../sidebar/row";
import { type Mark, type SessionRow, statusWords } from "../sidebar/words";
import { useProjects } from "./projects";
import { daemonSettings, ProjectSettings } from "./settings";

/*
 * A project's page, a main panel [D780]: Sessions, Pull requests and Settings under one header with
 * Open on GitHub and New session; a sidebar project row opens it. Sessions is a Workspaces-style list: a search,
 * the activity chips with their counts, then the rows grouped by what they need, each opening its session.
 */

export type ProjectTab = "sessions" | "prs" | "settings";
export const PROJECT_TABS: { value: ProjectTab; label: string }[] = [
  { value: "sessions", label: "Sessions" },
  { value: "prs", label: "Pull requests" },
  { value: "settings", label: "Settings" },
];

const TAB = cx(
  "relative flex h-12 cursor-pointer items-center text-sm text-muted-foreground hover:text-foreground focus-visible:focus-ring",
  "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full data-active:text-foreground data-active:after:bg-foreground",
);

/** The chips, each a few of our marks [D173]: Archived lists the archived ones instead. */
const FILTERS = [
  { value: "all", label: "All" },
  { value: "needs", label: "Needs you" },
  { value: "running", label: "Running" },
  { value: "waiting", label: "Waiting" },
  { value: "archived", label: "Archived" },
] as const;
type Filter = (typeof FILTERS)[number]["value"];
const GROUPS: { value: Exclude<Filter, "all" | "archived">; label: string }[] = [
  { value: "needs", label: "Needs you" },
  { value: "running", label: "Running" },
  { value: "waiting", label: "Waiting" },
];
const groupOf = (mark: Mark) => (mark === "needs" || mark === "amber" ? "needs" : mark === "working" ? "running" : mark === "background" ? "waiting" : "idle");

/** The page with its parts given: `prs` and `settings` are their tabs' bodies, `rows` this project's sessions. */
export function ProjectPageView({
  tab,
  rows,
  now,
  repo,
  prs,
  settings,
  onTab,
  onOpen,
  onNewSession,
  onRename,
}: {
  tab: ProjectTab;
  /** Its sessions, archived ones too; undefined until the first list. */
  rows: SessionRow[] | undefined;
  now: number;
  /** Its repository's page on GitHub, when it's there. */
  repo?: string | null;
  prs: ReactNode;
  settings: ReactNode;
  onTab: (tab: ProjectTab) => void;
  onOpen: (id: string) => void;
  onNewSession: () => void;
  onRename: (row: SessionRow) => void;
}) {
  return (
    <Tabs.Root value={tab} onValueChange={(next: ProjectTab) => onTab(next)} className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-6 border-b border-divider px-6">
        <Tabs.List className="flex min-w-0 flex-1 gap-5">
          {PROJECT_TABS.map((each) => (
            <Tabs.Tab key={each.value} value={each.value} className={TAB}>
              {each.label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        <span className="flex shrink-0 items-center gap-2 py-2">
          {repo && (
            <TooltipIconButton tooltip="Open on GitHub" size="icon-sm" onClick={() => window.open(repo)}>
              <ArrowUpRight />
            </TooltipIconButton>
          )}
          <Button size="sm" onClick={onNewSession}>
            <Plus />
            New session
          </Button>
        </span>
      </header>
      <Tabs.Panel value="sessions" className="flex min-h-0 flex-1 flex-col">
        <Sessions rows={rows} now={now} onOpen={onOpen} onNewSession={onNewSession} onRename={onRename} />
      </Tabs.Panel>
      <Tabs.Panel value="prs" className="flex min-h-0 flex-1 flex-col">
        {prs}
      </Tabs.Panel>
      <Tabs.Panel value="settings" className="flex min-h-0 flex-1 flex-col">
        {settings}
      </Tabs.Panel>
    </Tabs.Root>
  );
}

/** A tab's bar: its search, then its chips at the end, each with its count. */
export function TabBar<T extends string>({ search, text, onText, label, chips, value, onValue }: { search: string; text: string; onText: (text: string) => void; label: string; chips: { value: T; label: string; count?: number }[]; value: T; onValue: (value: T) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-3 px-6 py-4">
      <div className="flex max-w-60 min-w-24 flex-1">
        <SearchField label={search} value={text} onChange={onText} />
      </div>
      <SegmentedRoot aria-label={label} value={[value]} onValueChange={([next]) => next && onValue(next as T)} className="ms-auto flex shrink-0 items-center gap-0.5 rounded-capsule bg-fill-subtle p-0.5">
        {chips.map((each) => (
          <Segment key={each.value} value={each.value} className={cx(CHIP, "flex items-center gap-1.5")}>
            {each.label}
            {each.count !== undefined && <span className="tabular-nums opacity-70">{each.count}</span>}
          </Segment>
        ))}
      </SegmentedRoot>
    </div>
  );
}

/** A tab's group: its heading folds it, with its count; then its rows. */
export function Group({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="pt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-8 cursor-pointer items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:focus-ring"
      >
        {label}
        <ChevronDown className={cx("size-icon-xs", !open && "-rotate-90")} />
        {count !== undefined && <span className="tabular-nums">{count}</span>}
      </button>
      {open && <ul aria-label={label}>{children}</ul>}
    </section>
  );
}

/** A Workspaces-style tab, our sessions in it. */
function Sessions({ rows, now, onOpen, onNewSession, onRename }: { rows: SessionRow[] | undefined; now: number; onOpen: (id: string) => void; onNewSession: () => void; onRename: (row: SessionRow) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [text, setText] = useState("");
  const live = rows?.filter((row) => !row.archived) ?? [];
  const count = (value: Filter) => (value === "all" ? live.length : live.filter((row) => groupOf(row.mark) === value).length);
  const words = text.trim().toLowerCase();
  const shown = (filter === "archived" ? (rows ?? []).filter((row) => row.archived) : live)
    .filter((row) => filter === "all" || filter === "archived" || groupOf(row.mark) === filter)
    .filter((row) => !words || (row.title || "New session").toLowerCase().includes(words));
  const groups: [string, string, SessionRow[]][] =
    filter === "archived" ? [["archived", "", shown]] : [...GROUPS, { value: "idle", label: "Done & idle" }].map(({ value, label }) => [value, label, shown.filter((row) => groupOf(row.mark) === value)]);
  return (
    <>
      <TabBar
        search="Search sessions…"
        text={text}
        onText={setText}
        label="Sessions"
        chips={FILTERS.map((each) => ({ ...each, count: each.value === "archived" ? undefined : count(each.value) }))}
        value={filter}
        onValue={setFilter}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
        {rows === undefined ? null : shown.length === 0 ? (
          <div className="flex flex-col items-center gap-3 pt-24">
            <EmptyState
              variant="centered"
              title={live.length === 0 && filter === "all" ? "No sessions yet" : "No matching sessions"}
              detail={live.length === 0 && filter === "all" ? "Start a session to give your next task a place to live." : "Try another search or filter."}
            />
            {live.length === 0 && filter === "all" ? (
              <Button size="sm" onClick={onNewSession}>
                New session
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setFilter("all");
                  setText("");
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        ) : (
          groups.map(
            ([key, label, each]) =>
              each.length > 0 && (
                <Group key={key} label={label || "Archived"} count={each.length}>
                  {each.map((row) => (
                    <Line key={row.id} row={row} now={now} onOpen={onOpen} onRename={onRename} />
                  ))}
                </Group>
              ),
          )
        )}
      </div>
    </>
  );
}

/** A row: the title, then its PRs, its mark, when it last moved and its menu; a click opens the session. */
function Line({ row, now, onOpen, onRename }: { row: SessionRow; now: number; onOpen: (id: string) => void; onRename: (row: SessionRow) => void }) {
  const title = row.title || "New session";
  const words = statusWords(row) ?? "";
  const items = <RowMenuItems row={row} onRename={() => onRename(row)} />;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<li data-row-id={row.id} className="group/line border-b border-divider" />}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => onOpen(row.id)}
          onKeyDown={(event) => event.key === "Enter" && onOpen(row.id)}
          className="flex h-12 cursor-pointer items-center gap-3 rounded-control px-2 text-sm hover:bg-fill-subtle focus-visible:focus-ring"
        >
          {row.brigade && <BrigadeGlyph aria-label="Brigade" className="size-icon-md shrink-0 text-muted-foreground" />}
          {row.forkOf && <BranchAlt aria-label="Fork" className="size-icon-sm shrink-0 text-muted-foreground" />}
          <span title={title} className={cx("min-w-0 flex-1 truncate font-medium", row.archived ? "text-marker-foreground" : "text-foreground")}>
            {title}
          </span>
          <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground tabular-nums">
            {row.pr && <span>{prList(row.pr)}</span>}
            {words && <span className="max-w-60 truncate">{words}</span>}
            <RowMark mark={row.mark} label={words} />
            {/* The short age: 4m, 2h, 3d. */}
            <span className="w-8 text-end whitespace-nowrap">{ago(row.updated ?? row.sent, now).replace(/ (s|min|h|d) ago/, (_, unit: string) => unit[0]!)}</span>
            {/* Its menu's clicks and keys bubble through the portal to the row: they stop here. */}
            <span className="contents" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger render={<RowAction aria-label={`Actions for ${title}`} />}>
                  <DotsHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">{items}</DropdownMenuContent>
              </DropdownMenu>
            </span>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>{items}</ContextMenuContent>
    </ContextMenu>
  );
}

/** The page at `#project/<id>/<tab>`, from Rust's rows and projects. */
export function ProjectPage({ id, tab }: { id: string; tab: ProjectTab }) {
  const { daemon, rows: all } = useDaemon();
  const projects = useProjects();
  const project = projects?.find((each) => each.id === id && !each.pending);
  const now = useSecond(true);
  const [renaming, setRenaming] = useState<SessionRow | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  // As the sidebar has them: a worker is its parent's, not a row [D3012].
  const sessions = useMemo(() => all?.filter((row) => !((row as { worker?: unknown }).worker && !row.boss) && !(row as { noteChat?: boolean }).noteChat), [all]);
  const rows = useShown(sessions)?.filter((row) => row.project === id);
  // Rust's local read of its GitHub repository, no network [D631].
  useEffect(() => {
    setRepo(null);
    if (daemon) void daemonSettings.accounts(id, true).then((reply) => setRepo(reply.github ? (reply.url ?? null) : null), () => {});
  }, [daemon, id, project?.folder]);
  if (!project) {
    return projects === undefined ? null : <EmptyState variant="centered" icon={Folder} title="This project isn’t available" detail="Brigadier has no project by this name. Pick another in the sidebar." className="m-auto" />;
  }
  return (
    <>
      <ProjectPageView
        tab={tab}
        rows={rows}
        now={now}
        repo={repo}
        onTab={(next) => openProject(id, next)}
        onOpen={(row) => (window.location.hash = `#thread/${encodeURIComponent(row)}`)}
        onNewSession={() => newSession(id)}
        onRename={setRenaming}
        prs={
          <HostOf.Provider value={id}>
            {/* A row opens its Pull request tab in Home, on this project, as Home's list does [D613]. */}
            <PrList
              owner={HOME}
              onOpen={(pr) => {
                setHomeDraft({ project: id, chat: false });
                setHomeTabs(id);
                openPr(HOME, pr);
                window.location.hash = "";
              }}
            />
          </HostOf.Provider>
        }
        settings={<ProjectSettings project={project} source={daemonSettings} />}
      />
      <RenameDialog row={renaming} onClose={() => setRenaming(null)} onRename={(title, branch) => renaming && rename(renaming, title, branch)} />
    </>
  );
}

/** Opens a project's page on Sessions, or the tab it was on. */
export const openProject = (id: string, tab?: ProjectTab) => (window.location.hash = `#project/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}`);

/** `#project/<id>[/<tab>]`'s project and tab, or null. */
export function projectPageOf(hash: string): { id: string; tab: ProjectTab } | null {
  if (!hash.startsWith("#project/")) return null;
  const [id = "", tab] = hash.slice("#project/".length).split("/");
  return { id: decodeURIComponent(id), tab: PROJECT_TABS.some((each) => each.value === tab) ? (tab as ProjectTab) : "sessions" };
}
