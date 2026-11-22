import { EmptyState } from "../components/empty-state";
import { useDaemon } from "../daemon";
import { setHomeDraft } from "../home/start";
import { Folder } from "../icons";
import { HOME, placeOf } from "../shell/tab-store";
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
    <div className="flex min-h-0 flex-1 flex-col">
      <ProjectSettings key={id} project={project} source={daemonSettings} />
    </div>
  );
}

/** Opens a project's page. */
export const openProject = (id: string) => (window.location.hash = `#project/${encodeURIComponent(id)}`);

/** A project's row or strip square: back to the last place used in it, else `none` (its page) when there's none or you're there [D865]. */
export function useOpenPlace(none: (id: string) => void = openProject): (id: string) => void {
  const { rows } = useDaemon();
  return (id) => {
    const at = placeOf(id, (each) => Boolean(rows?.some((row) => row.id === each && !row.archived)), window.location.hash);
    if (at === HOME) {
      setHomeDraft({ project: id, chat: false, locked: true });
      window.location.hash = "";
    } else if (at) window.location.hash = `#thread/${encodeURIComponent(at)}`;
    else none(id);
  };
}

/** `#project/<id>`'s project, or null; an old `#project/<id>/<tab>` is its project's too. */
export function projectPageOf(hash: string): string | null {
  return hash.startsWith("#project/") ? decodeURIComponent(hash.slice("#project/".length).split("/")[0] ?? "") : null;
}
