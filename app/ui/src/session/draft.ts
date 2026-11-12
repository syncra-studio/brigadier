import { type Draft, EMPTY_DRAFT, isEmpty } from "../components/composer/draft";
import type { Runner } from "./composer";

/*
 * Each session's unsent words [D363]. Rust keeps them in the session's folder, so they outlive a restart and go with
 * the session; this copy is what brings them back at once on a switch. Home's words go the same way, under HOME_DRAFT.
 */
export const HOME_DRAFT = "@home";
const SAVE_MS = 400;
const drafts = new Map<string, Draft>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const writing = new Set<string>();

export const draftOf = (id: string) => drafts.get(id);

/** One write at a time per session, so the last words typed are the last written. */
function write(run: Runner, id: string): void {
  if (writing.has(id)) return;
  writing.add(id);
  const draft = drafts.get(id) ?? EMPTY_DRAFT;
  void run(["draft", id, isEmpty(draft) ? "" : JSON.stringify(draft)]).then(() => {
    writing.delete(id);
    if (drafts.get(id) !== draft) write(run, id);
  });
}

/** Keeps what the composer holds now, its files' ids too; an emptied one (a sent message) drops the draft at once. */
export function keepDraft(run: Runner, id: string, draft: Draft): void {
  drafts.set(id, draft);
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => write(run, id), isEmpty(draft) ? 0 : SAVE_MS));
}

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
  const draft: Draft = Array.isArray(saved) ? { parts: saved, attachmentIds: [] } : saved && typeof saved === "object" && Array.isArray((saved as Draft).parts) ? { parts: (saved as Draft).parts, attachmentIds: (saved as Draft).attachmentIds ?? [] } : EMPTY_DRAFT;
  drafts.set(id, draft);
  return isEmpty(draft) ? null : draft;
}
