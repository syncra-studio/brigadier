import { type Draft, isEmpty } from "../components/composer/draft";
import type { Runner } from "./composer";

type Parts = Draft["parts"];

/*
 * Each session's unsent words [D363]. Rust keeps them in the session's folder, so they outlive a restart and go with
 * the session; this copy is what brings them back at once on a switch. Home's draft is its own (home/start.ts).
 */
const SAVE_MS = 400;
const drafts = new Map<string, Parts>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const writing = new Set<string>();

export const draftOf = (id: string) => drafts.get(id);

/** One write at a time per session, so the last words typed are the last written. */
function write(run: Runner, id: string): void {
  if (writing.has(id)) return;
  writing.add(id);
  const parts = drafts.get(id) ?? [];
  void run(["draft", id, isEmpty({ parts, attachmentIds: [] }) ? "" : JSON.stringify(parts)]).then(() => {
    writing.delete(id);
    if (drafts.get(id) !== parts) write(run, id);
  });
}

/** Keeps what the field holds now; an emptied field (a sent message) drops the draft at once. */
export function keepDraft(run: Runner, id: string, parts: Parts): void {
  drafts.set(id, parts);
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => write(run, id), isEmpty({ parts, attachmentIds: [] }) ? 0 : SAVE_MS));
}

/** The draft Rust holds, the first time this run opens the session; later opens have it in memory. */
export async function loadDraft(run: Runner, id: string): Promise<Parts | null> {
  if (drafts.has(id)) return null;
  const reply = await run(["draft", id]);
  if (!reply.ok || drafts.has(id)) return null;
  let parts: Parts = [];
  try {
    parts = reply.draft ? JSON.parse(reply.draft) : [];
  } catch {
    // Not ours to show; the next words typed replace it.
  }
  if (!Array.isArray(parts)) parts = [];
  drafts.set(id, parts);
  return parts.length > 0 ? parts : null;
}
