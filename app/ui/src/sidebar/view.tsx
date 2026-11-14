import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/menu";
import { RowAction } from "../components/row-action";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ListFilter } from "../icons";
import { openAddProject } from "../projects/store";
import { ProjectBadge } from "./row";
import { useStored } from "./sidebar";
import type { Project, SessionRow } from "./words";

export type Grouping = "none" | "project";

/** What the View control leaves out of the list, kept as this window's view. */
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

/**
 * The View button in the search field and its menu [new-design]: Inbox, one list across projects, or Projects,
 * grouped; then Show, each project with its badge, then chats without one, a tick each, staying open while
 * ticked; then Add project. Beside the button, how many projects show while anything is left out.
 */
export function ViewMenu({ grouping, onGrouping, projects, show }: { grouping: Grouping; onGrouping: (next: Grouping) => void; projects: Project[]; show: ShowFilter }) {
  const shown = projects.length - show.hiddenProjects.size;
  const tickProject = (id: string, on: boolean) => {
    const others = [...show.hiddenProjects].filter((each) => each !== id);
    show.setHiddenProjects(on ? others : [...others, id]);
  };
  return (
    <>
      {!show.all && <span className="me-1 text-xs whitespace-nowrap text-marker-foreground">{shown === 1 ? "1 project" : `${shown} projects`}</span>}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger render={<DropdownMenuTrigger render={<RowAction header round aria-label="View" data-filtered={!show.all || undefined} className="aria-expanded:bg-fill data-filtered:bg-fill data-filtered:text-foreground" />} />}>
            <ListFilter />
          </TooltipTrigger>
          <TooltipContent side="bottom">View</TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="bottom" align="end" className="w-60">
          <DropdownMenuRadioGroup value={grouping} onValueChange={(next) => onGrouping(next as Grouping)}>
            <DropdownMenuRadioItem inset closeOnClick={false} value="none">
              Inbox
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem inset closeOnClick={false} value="project">
              Projects
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel inset variant="heading">
            Show
          </DropdownMenuLabel>
          {projects.toSorted((a, b) => a.name.localeCompare(b.name)).map((project) => (
            <DropdownMenuCheckboxItem key={project.id} inset closeOnClick={false} checked={!show.hiddenProjects.has(project.id)} onCheckedChange={(on) => tickProject(project.id, on)}>
              <ProjectBadge name={project.name} tone={projects.indexOf(project)} />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuCheckboxItem inset closeOnClick={false} checked={!show.hideChats} onCheckedChange={(on) => show.setHideChats(!on)}>
            <ProjectBadge name={null} tone={undefined} />
            <span className="min-w-0 flex-1 truncate">Chats without a project</span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem inset onClick={() => openAddProject()}>
            Add project…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
