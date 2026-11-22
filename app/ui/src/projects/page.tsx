import { EmptyState } from "../components/empty-state";
import { ScrollFade } from "../components/scroll-fade";
import { Folder } from "../icons";
import { useProjects } from "./projects";
import { daemonSettings, ProjectSettings } from "./settings";

/** A project's page, `#project/<id>`, is its settings [D176]: the strip's Projects [D75] and the row's "…" [D30] open it. */
export function ProjectPage({ id }: { id: string }) {
  const projects = useProjects();
  const project = projects?.find((each) => each.id === id && !each.pending);
  if (!project) {
    return projects === undefined ? null : <EmptyState variant="centered" icon={Folder} title="This project isn’t available" detail="Brigadier has no project by this name. Pick another in the sidebar." className="m-auto" />;
  }
  return (
    // From the window's top, as Settings: the page scrolls under the titlebar's row, fading there [D292].
    <div className="relative -mt-tab-bar flex min-h-0 flex-1 flex-col">
      <ProjectSettings key={id} project={project} source={daemonSettings} />
      <ScrollFade side="top" />
    </div>
  );
}

/** Opens a project's page. */
export const openProject = (id: string) => (window.location.hash = `#project/${encodeURIComponent(id)}`);

/** `#project/<id>`'s project, or null; an old `#project/<id>/<tab>` is its project's too. */
export function projectPageOf(hash: string): string | null {
  return hash.startsWith("#project/") ? decodeURIComponent(hash.slice("#project/".length).split("/")[0] ?? "") : null;
}
