import { type Draft, EMPTY_DRAFT, isEmpty } from "../components/composer/draft";
import type { Runner } from "./composer";

/*
 * Each session's unsent words [D363]. Rust keeps them in the session's folder, so they outlive a restart and go with
 * the session; this copy is what brings them back at once on a switch. Home's words go the same way, under HOME_DRAFT.
 */
export const HOME_DRAFT = "@home";
const SAVE_MS = 400;
/** `project`: read only, the one picked in New chat's draft of before each project had its own. */
type Saved = Draft & { project?: string | null };
const drafts = new Map<string, Saved>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const writing = new Map<string, Promise<boolean>>();
const loading = new Map<string, Promise<Draft | null>>();

export const draftOf = (id: string) => drafts.get(id);

/** One write at a time per session, so the last words typed are the last written; whether they were. */
function write(run: Runner, id: string): Promise<boolean> {
  const job = writing.get(id) ?? save(run, id);
  writing.set(id, job);
  return job;
}

async function save(run: Runner, id: string): Promise<boolean> {
  const draft = drafts.get(id) ?? EMPTY_DRAFT;
  const reply = await run(["draft", id, isEmpty(draft) ? "" : JSON.stringify(draft)]);
  if ((drafts.get(id) ?? EMPTY_DRAFT) !== draft) return save(run, id);
  writing.delete(id);
  return Boolean(reply.ok);
}

/** Keeps what the composer holds now, its files' ids too; an emptied one (a sent message) drops the draft at once. */
export function keepDraft(run: Runner, id: string, draft: Draft): void {
  drafts.set(id, draft);
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => void write(run, id), isEmpty(draft) ? 0 : SAVE_MS));
}

/** Draft `from` becomes `to`'s, saved there before it goes from here; not saved, it's in both. */
export function moveDraft(run: Runner, from: string, to: string): void {
  const draft = drafts.get(from);
  if (!draft || isEmpty(draft)) return;
  drafts.set(to, { parts: draft.parts, attachmentIds: draft.attachmentIds });
  drafts.set(from, EMPTY_DRAFT);
  for (const id of [from, to]) clearTimeout(timers.get(id));
  void write(run, to).then((saved) => {
    if (saved) void write(run, from);
    else if (isEmpty(drafts.get(from)!)) drafts.set(from, draft);
  });
}

/** The project kept with New chat's draft of before each project had its own: null for none, undefined never picked. */
export const oldProject = (id: string) => drafts.get(id)?.project;

/** The draft Rust holds, the first time this run opens the session; later opens have it in memory. Asked twice at once, both get it. */
export function loadDraft(run: Runner, id: string): Promise<Draft | null> {
  if (drafts.has(id)) return Promise.resolve(null);
  const asked = loading.get(id) ?? readDraft(run, id).finally(() => loading.delete(id));
  loading.set(id, asked);
  return asked;
}

async function readDraft(run: Runner, id: string): Promise<Draft | null> {
  const reply = await run(["draft", id]);
  if (!reply.ok || drafts.has(id)) return null;
  let saved: unknown = null;
  try {
    saved = reply.draft ? JSON.parse(reply.draft) : null;
  } catch {
    // Not ours to show; the next words typed replace it.
  }
  // Saved before its files were kept, a draft was its parts alone.
  const draft: Saved = Array.isArray(saved) ? { parts: saved, attachmentIds: [] } : saved && typeof saved === "object" && Array.isArray((saved as Draft).parts) ? { parts: (saved as Draft).parts, attachmentIds: (saved as Draft).attachmentIds ?? [] } : { ...EMPTY_DRAFT };
  const project = (saved as Saved | null)?.project;
  if (typeof project === "string" || project === null) draft.project = project;
  drafts.set(id, draft);
  return isEmpty(draft) ? null : draft;
}
