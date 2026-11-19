import { showToast } from "../components/toast";
import { type Project, useDaemon } from "../daemon";
import { errorText, run, store } from "../onboarding/api";

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
  // A pending add gives way to Rust's record once the list holds it.
  const shown: Shown[] = list.map((project) => (mine.get(project.id)?.pending ? project : (mine.get(project.id) ?? project)));
  for (const [id, project] of mine) if (!list.some((each) => each.id === id)) shown.push(project);
  return shown.toSorted((a, b) => a.added - b.added);
}

/** An id made here for a project being added, so its row shows at once and settles by it [D30]. */
export const newProjectId = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * Adds the repository `folder` is in as a project, or with `args` a clone or new repository there:
 * shown at once as pending under `id`, then Rust's record under the same id, or gone with Rust's
 * reason thrown [D30, D165]. Through a lost daemon it stays pending (the "disconnected" error is
 * still thrown) and settles when the list holds `id`.
 */
export async function addProject(folder: string, args = ["add", folder], id = newProjectId()): Promise<Project> {
  hold(id, { id, name: baseName(folder), folder, trusted: null, setup: "", include: [], added: Date.now(), pending: true });
  try {
    const reply = await run(["projects", ...args, "--id", id]);
    hold(id);
    return reply.project as Project;
  } catch (cause) {
    // shortcut: an add that fails while the daemon is away stays pending until the app restarts; keep each run's outcome by id in the daemon if that shows up.
    if (errorText(cause) !== "disconnected") hold(id);
    throw cause;
  }
}

/**
 * Changes a project's record with `projects set <id> …args`: shown at once, then Rust's record by id,
 * or taken back with Rust's reason thrown [D30].
 */
export async function setProject(project: Project, change: Partial<Project>, args: string[]): Promise<void> {
  const shown = { ...project, ...change };
  hold(project.id, shown);
  try {
    const reply = await run(["projects", "set", project.id, ...args]);
    // The answer is saved even where a CLI's own trust entry couldn't be written [D166, D253].
    for (const { agent, error } of (reply.trust_errors ?? []) as { agent: string; error: string }[]) {
      showToast(agent
        ? `Saved. Brigadier couldn't record it for ${agent}, so ${agent} may ask again in its terminal: ${error}`
        : `Saved. Brigadier couldn't record it everywhere: ${error}`, { tone: "error" });
    }
  } finally {
    // A later change holds its own: only this one's overlay goes.
    if (overlay.get().get(project.id) === shown) hold(project.id);
  }
}

/** Pins a project to the sidebar's Pinned by projects, or unpins it: shown at once, taken back with Rust's reason [D30, D808]. */
export async function pinProject(project: Project, on: boolean): Promise<void> {
  const shown = { ...project, pinned: on ? Date.now() : null };
  hold(project.id, shown);
  try {
    await run(["projects", "pin", project.id, ...(on ? [] : ["--off"])]);
  } catch (cause) {
    showToast(`Couldn't ${on ? "pin" : "unpin"} ${project.name}: ${errorText(cause)}`, { tone: "error" });
  } finally {
    if (overlay.get().get(project.id) === shown) hold(project.id);
  }
}
