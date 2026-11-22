import { type Draft, EMPTY_DRAFT, isEmpty } from "../components/composer/draft";
import type { Runner } from "./composer";

/*
 * Each session's unsent words [D363]. Rust keeps them in the session's folder, so they outlive a restart and go with
 * the session; this copy is what brings them back at once on a switch. Home's words go the same way, under HOME_DRAFT.
 */
export const HOME_DRAFT = "@home";
const SAVE_MS = 400;
/** New chat's draft also keeps the project picked in it, an id or null for none, so a relaunch brings it back [D284]. */
type Saved = Draft & { project?: string | null };
const drafts = new Map<string, Saved>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const writing = new Set<string>();

export const draftOf = (id: string) => drafts.get(id);

/** One write at a time per session, so the last words typed are the last written. */
function write(run: Runner, id: string): void {
  if (writing.has(id)) return;
  writing.add(id);
  const draft: Saved = drafts.get(id) ?? EMPTY_DRAFT;
  void run(["draft", id, isEmpty(draft) && draft.project === undefined ? "" : JSON.stringify(draft)]).then(() => {
    writing.delete(id);
    if (drafts.get(id) !== draft) write(run, id);
  });
}

/** Keeps what the composer holds now, its files' ids too; an emptied one (a sent message) drops the draft at once. */
export function keepDraft(run: Runner, id: string, draft: Draft): void {
  const project = drafts.get(id)?.project;
  drafts.set(id, project === undefined ? draft : { ...draft, project });
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => write(run, id), isEmpty(draft) ? 0 : SAVE_MS));
}

/** The project picked in draft `id`, kept with its words; a send empties the words, not this [D284]. */
export function keepProject(run: Runner, id: string, project: string | null): void {
  drafts.set(id, { ...(drafts.get(id) ?? EMPTY_DRAFT), project });
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => write(run, id), 0));
}

/** The project kept with draft `id`: undefined when none was picked there or it isn't loaded yet. */
export const projectOf = (id: string) => drafts.get(id)?.project;

/** The draft Rust holds, the first time this run opens the session; later opens have it in memory. */
export async function loadDraft(run: Runner, id: string): Promise<Draft | null> {
  if (drafts.has(id)) return null;
  const reply = await run(["draft", id]);
  if (!reply.ok || drafts.has(id)) return null;
  let saved: unknown = null;
  try {
    saved = reply.draft ? JSON.parse(reply.draft) : null;
  } catch {
    // Not ours to show; the next words typed replace it.
  }
  // Saved before its files were kept, a draft was its parts alone.
  const draft: Saved = Array.isArray(saved) ? { parts: saved, attachmentIds: [] } : saved && typeof saved === "object" && Array.isArray((saved as Draft).parts) ? { parts: (saved as Draft).parts, attachmentIds: (saved as Draft).attachmentIds ?? [] } : EMPTY_DRAFT;
  const project = (saved as Saved | null)?.project;
  if (typeof project === "string" || project === null) draft.project = project;
  drafts.set(id, draft);
  return isEmpty(draft) ? null : draft;
}
