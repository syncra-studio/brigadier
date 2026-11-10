import { type ReactNode, useId, useState } from "react";

import { Checkbox } from "../components/checkbox";
import { cx } from "../components/cx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { Radio, RadioGroup } from "../components/radio";
import { RowAction } from "../components/row-action";
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
  keeps: (row: SessionRow) => boolean;
  setHiddenProjects: (ids: string[]) => void;
  setHideChats: (hide: boolean) => void;
};

export function useShowFilter(storeKey: string, projects: Project[]): ShowFilter {
  const [hidden, setHiddenProjects] = useStored<string[]>(`${storeKey}.hiddenProjects`, []);
  const [hideChats, setHideChats] = useStored(`${storeKey}.hideChats`, false);
  const hiddenProjects = new Set(hidden.filter((id) => projects.some((project) => project.id === id)));
  return {
    hiddenProjects,
    hideChats,
    all: hiddenProjects.size === 0 && !hideChats,
    keeps: (row) => (row.project === null ? !hideChats : !hiddenProjects.has(row.project)),
    setHiddenProjects,
    setHideChats,
  };
}

const GROUPINGS = [
  ["none", "None"],
  ["project", "Project"],
] as const;

const HEADING = "px-2 py-1.5 text-sm text-muted-foreground";
const ROW = "flex h-control-sm cursor-pointer items-center gap-2 rounded-menu-item px-2 text-sm hover:bg-fill has-focus-visible:bg-fill";
const RULE = "mx-2 my-1 border-t border-divider";

/** A line of the Show list: its tick, what it stands for, and how many it holds. */
function ShowRow({ name, checked, onChange, mark, count, none }: { name: string; checked: boolean; onChange: (on: boolean) => void; mark?: ReactNode; count: number; none?: string }) {
  const empty = count === 0 && none !== undefined;
  return (
    <label className={ROW}>
      <Checkbox aria-label={name} checked={checked} onCheckedChange={(next) => onChange(next)} />
      {mark}
      <span title={name} className={cx("min-w-0 flex-1 truncate", empty && "text-muted-foreground")}>{name}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{empty ? none : count}</span>
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
 * Group by None or Project, and Show: All, No project, then each project with its count [D440], then Add project.
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
  const heading = useId();
  const count = (project: string | null) => rows.filter((row) => row.project === project).length;
  // All counts the lines ticked below it, No project and the projects.
  const ticked = projects.filter((project) => !show.hiddenProjects.has(project.id)).length + (show.hideChats ? 0 : 1);
  const tickProject = (id: string, on: boolean) => {
    const others = [...show.hiddenProjects].filter((each) => each !== id);
    show.setHiddenProjects(on ? others : [...others, id]);
  };
  // With everything ticked it unticks everything; from anything else it ticks everything.
  const tickAll = () => {
    show.setHiddenProjects(show.all ? projects.map((project) => project.id) : []);
    show.setHideChats(show.all);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {children}
      <PopoverContent side="bottom" align="end" className="w-60">
        <div id={heading} className={HEADING}>
          Group by
        </div>
        <RadioGroup aria-labelledby={heading} value={grouping} onValueChange={(next) => onGrouping(next as Grouping)}>
          {GROUPINGS.map(([value, label]) => (
            <label key={value} className={ROW}>
              <Radio value={value} />
              {label}
            </label>
          ))}
        </RadioGroup>
        <div className={RULE} />
        <div className={HEADING}>Show</div>
        <ShowRow name="All" checked={show.all} onChange={tickAll} count={ticked} />
        <ShowRow name="No project" checked={!show.hideChats} onChange={(on) => show.setHideChats(!on)} mark={<ProjectBadge name={null} tone={undefined} />} count={count(null)} none="No chats" />
        <div className={RULE} />
        <div className="scroll-edge-fade edge-fade-sidebar max-h-60 overflow-y-auto">
          {projects.map((project, tone) => (
            <ShowRow
              key={project.id}
              name={project.name}
              checked={!show.hiddenProjects.has(project.id)}
              onChange={(on) => tickProject(project.id, on)}
              mark={<ProjectBadge name={project.name} tone={tone} />}
              count={count(project.id)}
              none="No sessions"
            />
          ))}
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
