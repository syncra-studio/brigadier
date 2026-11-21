import { type ReactNode, useState } from "react";

import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { cx } from "../components/cx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger, MenuRow } from "../components/menu";
import { TooltipIconButton } from "../components/icon-button";
import { ArrowDownUp, Bolt, Chat, Check, ChevronRight, Comment, Eye, Filter, Folder, ListBullets, Plus, Sidebar } from "../icons";
import { openAddProject } from "../projects/store";
import { ProjectBadge } from "./row";
import { useStored } from "./sidebar";
import type { Project, SessionRow } from "./words";

/** The sidebar's mode [D806]: "project" By projects, "none" By sessions (kept under their old names, so the pick carries over). */
export type Grouping = "none" | "project";

/** What the View control leaves out of the list, kept like the grouping as this window's view. */
export type ShowFilter = {
  /** The unticked projects that still exist. */
  hiddenProjects: ReadonlySet<string>;
  hideChats: boolean;
  /** Nothing is left out. */
  all: boolean;
  /** In no project here: none, or one since removed. */
  homeless: (row: SessionRow) => boolean;
  keeps: (row: SessionRow) => boolean;
  setHiddenProjects: (ids: string[]) => void;
  setHideChats: (hide: boolean) => void;
};

export function useShowFilter(storeKey: string, projects: Project[]): ShowFilter {
  const [hidden, setHiddenProjects] = useStored<string[]>(`${storeKey}.hiddenProjects`, []);
  const [hideChats, setHideChats] = useStored(`${storeKey}.hideChats`, false);
  const hiddenProjects = new Set(hidden.filter((id) => projects.some((project) => project.id === id)));
  const homeless = (row: SessionRow) => row.project === null || !projects.some((project) => project.id === row.project);
  return {
    hiddenProjects,
    hideChats,
    all: hiddenProjects.size === 0 && !hideChats,
    homeless,
    keeps: (row) => (homeless(row) ? !hideChats : !hiddenProjects.has(row.project!)),
    setHiddenProjects,
    setHideChats,
  };
}

export type Sort = "sent" | "activity";

const RULE = "mx-2 my-1 border-t border-divider";
const HEADING = "px-2 py-1.5 text-sm text-muted-foreground";
const ROW = "flex h-control-sm cursor-pointer items-center gap-2 rounded-menu-item px-2 text-sm hover:bg-fill has-focus-visible:bg-fill";

/** A line of the Show list: its tick, what it stands for, and how many it holds (dimmed when none). */
function ShowRow({ name, checked, onChange, mark, count }: { name: string; checked: boolean; onChange: (on: boolean) => void; mark: ReactNode; count: number }) {
  return (
    <label className={ROW}>
      <Checkbox aria-label={name} checked={checked} onCheckedChange={(next) => onChange(next)} />
      {mark}
      <span title={name} className={cx("min-w-0 flex-1 truncate", count === 0 && "text-muted-foreground")}>{name}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{count}</span>
    </label>
  );
}

/** The View button, Filter, in the sidebar's header before Search [D23]; before it, how many projects show while anything is left out. */
export function ViewTrigger({ projects, show }: { projects: Project[]; show: ShowFilter }) {
  const shown = projects.length - show.hiddenProjects.size;
  return (
    <>
      {!show.all && <span className="me-1 text-xs whitespace-nowrap text-marker-foreground">{shown === 1 ? "1 project" : `${shown} projects`}</span>}
      <PopoverTrigger render={<TooltipIconButton tooltip="View" look="head" side="bottom" data-filtered={!show.all || undefined} className="data-filtered:bg-fill data-filtered:text-foreground" />}>
        <Filter />
      </PopoverTrigger>
    </>
  );
}

/** A row of the View menu that opens its own menu beside it [D655]. */
function SubMenu({ icon, title, wide = false, children }: { icon: ReactNode; title: string; wide?: boolean; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger openOnHover delay={0} className={cx(ROW, "w-full text-start outline-none data-popup-open:bg-fill")}>
        <span className="flex size-icon-md items-center justify-center text-muted-foreground svg:size-icon-md">{icon}</span>
        {title}
        <ChevronRight className="ms-auto size-icon-md text-muted-foreground rtl:rotate-180" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" sideOffset={10} alignOffset={-4} className={wide ? "w-64" : "w-56"}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const CHECK = <Check className="size-icon-md" />;

/**
 * Around the sidebar's header: Organize sidebar (By projects or By sessions [D806]), Sort by (your last
 * message, or anyone's last activity) and Show (each project, then chats without one, ticked, with counts, and
 * Show all while any is unticked [D440, D50]), each its own menu beside the row, then Add project [D655].
 */
export function ViewMenu({
  grouping,
  onGrouping,
  sort,
  onSort,
  projects,
  rows,
  show,
  children,
}: {
  grouping: Grouping;
  onGrouping: (next: Grouping) => void;
  sort: Sort;
  onSort: (next: Sort) => void;
  projects: Project[];
  /** The live rows, pinned ones too, before the filter. */
  rows: SessionRow[];
  show: ShowFilter;
  children: ReactNode;
}) {
  const count = (project: string | null) => rows.filter((row) => (project === null ? show.homeless(row) : row.project === project)).length;
  const tickProject = (id: string, on: boolean) => {
    const others = [...show.hiddenProjects].filter((each) => each !== id);
    show.setHiddenProjects(on ? others : [...others, id]);
  };
  const showAll = () => {
    show.setHiddenProjects([]);
    show.setHideChats(false);
  };
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {children}
      <PopoverContent side="bottom" align="end" className="w-52">
        <SubMenu icon={<Sidebar />} title="Organize sidebar">
          <DropdownMenuRadioGroup value={grouping} onValueChange={(next) => onGrouping(next as Grouping)} onClick={() => setOpen(false)}>
            <DropdownMenuRadioItem value="project" indicator={CHECK}>
              <MenuRow icon={<Folder />} title="By projects" />
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="none" indicator={CHECK}>
              <MenuRow icon={<ListBullets />} title="By sessions" />
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </SubMenu>
        <SubMenu icon={<ArrowDownUp />} title="Sort by">
          <DropdownMenuRadioGroup value={sort} onValueChange={(next) => onSort(next as Sort)}>
            <DropdownMenuRadioItem value="sent" indicator={CHECK}>
              <MenuRow icon={<Comment />} title="Your last message" />
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="activity" indicator={CHECK}>
              <MenuRow icon={<Bolt />} title="Last activity" />
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </SubMenu>
        <SubMenu icon={<Eye />} title="Show" wide>
          <div className="flex items-center justify-between pe-2">
            <div className={HEADING}>Projects</div>
            {!show.all && (
              <Button variant="link-blue" size="inline" onClick={showAll}>
                Show all
              </Button>
            )}
          </div>
          <div className="scroll-edge-fade edge-fade-sidebar max-h-60 overflow-y-auto">
            {projects.map((project, tone) => (
              <ShowRow
                key={project.id}
                name={project.name}
                checked={!show.hiddenProjects.has(project.id)}
                onChange={(on) => tickProject(project.id, on)}
                mark={<ProjectBadge id={project.id} name={project.name} tone={tone} />}
                count={count(project.id)}
              />
            ))}
            <ShowRow name="Chats without a project" checked={!show.hideChats} onChange={(on) => show.setHideChats(!on)} mark={<Chat aria-hidden className="size-icon-md shrink-0" />} count={count(null)} />
          </div>
        </SubMenu>
        <div className={RULE} />
        <button
          type="button"
          className={cx(ROW, "w-full text-start outline-none")}
          onClick={() => {
            setOpen(false);
            openAddProject();
          }}
        >
          <span className="flex size-icon-md items-center justify-center text-muted-foreground svg:size-icon-md">
            <Plus />
          </span>
          Add project…
        </button>
      </PopoverContent>
    </Popover>
  );
}
