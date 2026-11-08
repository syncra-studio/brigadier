import { type Project, useDaemon } from "../daemon";
import { run, store } from "../onboarding/api";

export type { Project };
/** A project as shown: `pending` while Rust hasn't answered an add made here [D30]. */
export type Shown = Project & { pending?: boolean };

// Memory only, by id. The daemon pushes a change before it answers the command, so a settled
// entry can go the moment its reply lands: the list already holds Rust's record [D30, D40].
const overlay = store<ReadonlyMap<string, Shown>>(new Map());

function hold(id: string, project?: Shown): void {
  const next = new Map(overlay.get());
  if (project) next.set(id, project);
  else next.delete(id);
  overlay.set(next);
}

const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/** The projects, oldest first, with this window's unanswered changes on top; undefined until the first list. */
export function useProjects(): Shown[] | undefined {
  const list = useDaemon().projects;
  const mine = overlay.use();
  if (!list) return undefined;
  const shown: Shown[] = list.map((project) => mine.get(project.id) ?? project);
  for (const [id, project] of mine) if (!list.some((each) => each.id === id)) shown.push(project);
  return shown.toSorted((a, b) => a.added - b.added);
}

/**
 * Adds the repository `folder` is in as a project: shown at once as pending under an id made
 * here, then Rust's record under the same id, or gone with Rust's reason thrown [D30, D165].
 */
export async function addProject(folder: string): Promise<Project> {
  const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  hold(id, { id, name: baseName(folder), folder, trusted: null, added: Date.now(), pending: true });
  try {
    return (await run(["projects", "add", folder, "--id", id])).project as Project;
  } finally {
    hold(id);
  }
}
