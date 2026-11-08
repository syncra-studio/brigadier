import { type ReactNode, useId, useState } from "react";

import { EmptyState } from "../components/empty-state";
import { TooltipIconButton } from "../components/icon-button";
import { NavFold, NavHeader, NavList, NavRow, NavSection } from "../components/nav";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { Radio, RadioGroup } from "../components/radio";
import { RowAction } from "../components/row-action";
import { SidebarPanel, useSidebar } from "../components/sidebar";
import { Skeleton } from "../components/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ComposeEditSquare, Folder, FolderOpen, SettingsSlider } from "../icons";
import { BrigadierMark } from "../onboarding/mark";
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
}) {
  const [grouping, setGrouping] = useStored<Grouping>(`${storeKey}.grouping`, "none");
  const [folded, setFolded] = useStored<string[]>(`${storeKey}.folded`, []);
  const isOpen = (key: string) => !folded.includes(key);
  const setOpen = (key: string, open: boolean) => setFolded(open ? folded.filter((each) => each !== key) : [...folded, key]);
  const sorted = rows?.toSorted(byLastSend);
  const projectOf = new Map(projects.map((project) => [project.id, project]));
  const row = (each: SessionRow, layout: { badged?: boolean; nested?: boolean }) => (
    <SessionRowItem
      key={each.id}
      row={each}
      project={each.project === null ? undefined : projectOf.get(each.project)}
      active={each.id === active}
      offline={offline}
      onOpen={onOpen}
      {...layout}
    />
  );
  const view = <ViewMenu grouping={grouping} onGrouping={setGrouping} />;

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
      <div className={LIST}>
        {sorted === undefined ? (
          <Loading />
        ) : grouping === "none" ? (
          <NavSection title="Open" open={isOpen("open")} onOpenChange={(open) => setOpen("open", open)} steadyEnd={view}>
            <NavList className="gap-1">
              {sorted.map((each) => row(each, { badged: true }))}
              {sorted.length === 0 && <EmptyState as="li" title="Sessions you start appear here." />}
            </NavList>
          </NavSection>
        ) : (
          <>
            <NavSection title="Projects" open={isOpen("projects")} onOpenChange={(open) => setOpen("projects", open)} steadyEnd={view}>
              <NavList>
                {projects.toSorted((a, b) => a.name.localeCompare(b.name)).map((project) => (
                  <ProjectRow key={project.id} name={project.name} open={isOpen(project.id)} onOpenChange={(open) => setOpen(project.id, open)}>
                    {sorted.filter((each) => each.project === project.id).map((each) => row(each, { nested: true }))}
                  </ProjectRow>
                ))}
                {projects.length === 0 && <EmptyState as="li" title="Projects group sessions on a repository." />}
              </NavList>
            </NavSection>
            {/* shortcut: sessions with no project (made before projects were records) sit under their own
                title; drop it once 1a gives every session a project. */}
            {sorted.some((each) => each.project === null || !projectOf.has(each.project)) && (
              <NavSection title="No project" open={isOpen("none")} onOpenChange={(open) => setOpen("none", open)}>
                <NavList>{sorted.filter((each) => each.project === null || !projectOf.has(each.project)).map((each) => row(each, {}))}</NavList>
              </NavSection>
            )}
          </>
        )}
      </div>
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
function ProjectRow({ name, open, onOpenChange, children }: { name: string; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode[] }) {
  return (
    <li className="flex flex-col">
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
  return (
    <Popover>
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
