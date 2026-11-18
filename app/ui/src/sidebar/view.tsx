import { type ReactNode, useState } from "react";

import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { cx } from "../components/cx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { RowAction } from "../components/row-action";
import { Segmented } from "../components/segmented";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Plus, SettingsSlider } from "../icons";
import { openAddProject } from "../projects/store";
import { ProjectBadge } from "./row";
import { useStored } from "./sidebar";
import type { Project, SessionRow } from "./words";

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

const GROUPINGS = [
  { value: "none", label: "None" },
  { value: "project", label: "Project" },
] as const;

const HEADING = "px-2 py-1.5 text-sm text-muted-foreground";
const ROW = "flex h-control-sm cursor-pointer items-center gap-2 rounded-menu-item px-2 text-sm hover:bg-fill has-focus-visible:bg-fill";
const RULE = "mx-2 my-1 border-t border-divider";

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

/** The View button, on the header of Open or of Projects; beside it, how many projects show while anything is left out. */
export function ViewTrigger({ projects, show }: { projects: Project[]; show: ShowFilter }) {
  const shown = projects.length - show.hiddenProjects.size;
  return (
    <>
      {!show.all && <span className="me-1 text-xs whitespace-nowrap text-marker-foreground">{shown === 1 ? "1 project" : `${shown} projects`}</span>}
      <Tooltip>
        <TooltipTrigger render={<PopoverTrigger render={<RowAction header aria-label="View" data-filtered={!show.all || undefined} className="aria-expanded:bg-fill data-filtered:bg-fill data-filtered:text-foreground" />} />}>
          <SettingsSlider />
        </TooltipTrigger>
        <TooltipContent side="bottom">View</TooltipContent>
      </Tooltip>
    </>
  );
}

/**
 * Around the sidebar's lists, so it stays open while Group by moves its button to the other list's header:
 * Group by None or Project, and Show: each project, then chats without one, each with its count, and Show all
 * while any is unticked [D440, D50]; then Add project.
 */
export function ViewMenu({
  grouping,
  onGrouping,
  projects,
  rows,
  show,
  children,
}: {
  grouping: Grouping;
  onGrouping: (next: Grouping) => void;
  projects: Project[];
  /** The live rows, pinned ones too, before the filter. */
  rows: SessionRow[];
  show: ShowFilter;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const count = (project: string | null) => rows.filter((row) => (project === null ? show.homeless(row) : row.project === project)).length;
  const tickProject = (id: string, on: boolean) => {
    const others = [...show.hiddenProjects].filter((each) => each !== id);
    show.setHiddenProjects(on ? others : [...others, id]);
  };
  const showAll = () => {
    show.setHiddenProjects([]);
    show.setHideChats(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {children}
      <PopoverContent side="bottom" align="end" className="w-60">
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="shrink-0 text-sm text-muted-foreground">Group by</span>
          <Segmented fill label="Group by" value={grouping} options={GROUPINGS} onChange={onGrouping} />
        </div>
        <div className={RULE} />
        <div className="flex items-center justify-between pe-2">
          <div className={HEADING}>Show</div>
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
          <ShowRow name="Chats without a project" checked={!show.hideChats} onChange={(on) => show.setHideChats(!on)} mark={<ProjectBadge name={null} tone={undefined} />} count={count(null)} />
        </div>
        <div className={RULE} />
        <button
          type="button"
          className={cx(ROW, "w-full text-start text-strip-foreground outline-none")}
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
