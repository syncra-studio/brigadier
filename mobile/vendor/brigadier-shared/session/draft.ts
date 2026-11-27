import { type Draft, EMPTY_DRAFT, isEmpty } from "../draft";
import type { Chip } from "../chips";
import type { Runner } from "./run";
import type { Uncertain } from "./uncertain";

/*
 * Each session's unsent words [D363]. Rust keeps them in the session's folder, so they outlive a restart and go with
 * the session; this copy is what brings them back at once on a switch. Home's words go the same way, under HOME_DRAFT, and its refused new chats come back into them [C65].
 */
export const HOME_DRAFT = "@home";
const SAVE_MS = 400;
/** `project`: read only, the one picked in New chat's draft of before each project had its own. */
type Saved = Draft & { project?: string | null };
/** A message Rust gave back: its words and files above the draft, its chips waiting again; a start's, its chat's own draft (`typed`). */
export type Given = { cid: string; parts: Draft["parts"]; attachmentIds: string[]; chips?: readonly Chip[]; error?: string; signIn?: boolean; typed?: Typed };
/** A refused new chat's own draft as Rust took it before its session went; what waited above its composer as words (`said`) [C80]. */
type Typed = { session: string; parts: Draft["parts"]; attachmentIds: string[]; said?: string };

/** One Mac's drafts [D58]: the desktop makes one, a phone one per paired Mac, so a draft or a give-back never crosses. */
export function draftState(uncertain: Uncertain) {
  const drafts = new Map<string, Saved>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const writing = new Map<string, Promise<boolean>>();
  const loading = new Map<string, Promise<Draft | null>>();
  /*
   * A draft, a session's or Home's, is revised in Rust, which gives a refused message back into it [D363, C65]: a save names the revision
   * it last saw and every message given back it has taken since, or it's stale and Rust says what it missed.
   */
  const revs = new Map<string, number>();
  const took = new Map<string, Set<string>>();
  const applied = new Map<string, Set<string>>();
  const errors = new Map<string, Given>();
  const setOf = (map: Map<string, Set<string>>, id: string) => map.get(id) ?? map.set(id, new Set()).get(id)!;
  const fills = new Map<string, (back: Given) => Draft>();
  const { keptOf, forget, fromBook, tellDrops, keptChipsBack } = uncertain;

  const draftOf = (id: string) => drafts.get(id);
  /** The revision of session `id`'s draft this view last saw: a message sent now carries it. */
  const revOf = (id: string) => revs.get(id) ?? 0;
  /** The last message given back refused to a session that wasn't open, once. */
  function givenRefused(id: string): Given | null {
    const back = errors.get(id) ?? null;
    errors.delete(id);
    return back;
  }
  const givenError = (id: string) => givenRefused(id)?.error ?? null;

  /** Fills session `id`'s open composer with a message given back, answering the draft it holds then. */
  function onGiven(id: string, fill: (back: Given) => Draft): () => void {
    fills.set(id, fill);
    return () => fills.get(id) === fill && fills.delete(id);
  }

  /** Asks Rust for what it gave back that this view may not have: a save, stale if it missed any, or a first read. */
  function resyncDraft(run: Runner, id: string): void {
    // Never read (the first read failed): what's read now goes into the open field above what's typed, as a give-back does.
    if (!drafts.has(id)) return void readDraft(run, id).then((saved) => saved && fills.has(id) && drafts.set(id, fills.get(id)!({ cid: "", ...saved })));
    clearTimeout(timers.get(id));
    void write(run, id);
  }

  /** Takes a message given back into session `id`'s draft, open or not, once per message; saved at once. */
  function takeBack(run: Runner, id: string, given: Given): void {
    const back = withTyped(given);
    setOf(took, id).add(back.cid);
    const kept = keptOf(id, back.cid);
    forget(id, back.cid);
    if (setOf(applied, id).has(back.cid)) return;
    setOf(applied, id).add(back.cid);
    keptChipsBack(id, kept, back.chips);
    const fill = fills.get(id);
    if (fill) drafts.set(id, fill(back));
    else {
      const now = drafts.get(id) ?? EMPTY_DRAFT;
      const parts = isEmpty({ parts: now.parts, attachmentIds: [] }) ? back.parts : [...back.parts, "\n\n", ...now.parts];
      drafts.set(id, { parts, attachmentIds: [...new Set([...back.attachmentIds, ...now.attachmentIds])] });
      if (back.error) errors.set(id, back);
    }
    clearTimeout(timers.get(id));
    void write(run, id);
  }

  /**
   * A start's message with its chat's own draft under it: the app's copy when it has one, never older than Rust's, with
   * only the tiles Rust copied home; its chips as words [C80].
   */
  function withTyped(back: Given): Given {
    const typed = back.typed;
    if (!typed) return back;
    const mine = drafts.get(typed.session);
    // shortcut: an image or paste put in after Rust read the draft has no file at Home, so its chip shows broken; upgrade if it's seen.
    const tiles = mine ? mine.attachmentIds.filter((each) => typed.attachmentIds.includes(each)) : typed.attachmentIds;
    const own = mine?.parts ?? typed.parts;
    const said = typed.said;
    const words = !said ? own : isEmpty({ parts: own, attachmentIds: [] }) ? [said] : [...own, "\n\n", said];
    if (isEmpty({ parts: words, attachmentIds: tiles })) return back;
    const parts = isEmpty({ parts: back.parts, attachmentIds: [] }) ? words : [...back.parts, "\n\n", ...words];
    return { ...back, parts, attachmentIds: [...new Set([...back.attachmentIds, ...tiles])] };
  }

  /** One write at a time per session, so the last words typed are the last written; whether they were. */
  function write(run: Runner, id: string): Promise<boolean> {
    const job = writing.get(id) ?? save(run, id);
    writing.set(id, job);
    return job;
  }

  async function save(run: Runner, id: string): Promise<boolean> {
    // A Delete first: what Rust gave back for that message isn't this save's to take [D363].
    await tellDrops(run, id);
    const draft = drafts.get(id) ?? EMPTY_DRAFT;
    const acked = [...setOf(took, id)];
    const revised = ["--base", String(revOf(id)), ...(acked.length > 0 ? ["--took", acked.join(",")] : [])];
    const reply = await run(["draft", id, isEmpty(draft) ? "" : JSON.stringify(draft), ...revised]);
    if (typeof reply.rev === "number") revs.set(id, reply.rev);
    if (reply.ok) for (const cid of acked) took.get(id)?.delete(cid);
    // Stale: what it missed comes in above, and it's saved again.
    for (const back of reply.stale ? (reply.given as Given[]) : []) takeBack(run, id, back);
    if (reply.stale || (drafts.get(id) ?? EMPTY_DRAFT) !== draft) return save(run, id);
    writing.delete(id);
    return Boolean(reply.ok);
  }

  /** Keeps what the composer holds now, its files' ids too; an emptied one (a sent message) drops the draft at once. */
  function keepDraft(run: Runner, id: string, draft: Draft): void {
    drafts.set(id, draft);
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => void write(run, id), isEmpty(draft) ? 0 : SAVE_MS));
  }

  /** Draft `from` becomes `to`'s, saved there before it goes from here; not saved, it's in both. */
  function moveDraft(run: Runner, from: string, to: string): void {
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
  const oldProject = (id: string) => drafts.get(id)?.project;

  /** The draft Rust holds, the first time this run opens the session; later opens have it in memory. Asked twice at once, both get it. */
  function loadDraft(run: Runner, id: string): Promise<Draft | null> {
    if (drafts.has(id)) return Promise.resolve(null);
    const asked = loading.get(id) ?? readDraft(run, id).finally(() => loading.delete(id));
    loading.set(id, asked);
    return asked;
  }

  async function readDraft(run: Runner, id: string): Promise<Draft | null> {
    // A message deleted where it waited goes first: what Rust gave back for it never comes in [D363].
    if (!id.startsWith(HOME_DRAFT)) await tellDrops(run, id);
    const reply = await run(["draft", id]);
    if (!reply.ok) return null;
    // Its messages on their way, Rust's from now on, whatever was typed meanwhile.
    if (Array.isArray(reply.going)) fromBook(id, reply.going);
    if (drafts.has(id)) return null;
    // What Rust gave back since the last save is in the draft it read already.
    if (typeof reply.rev === "number") revs.set(id, reply.rev);
    for (const cid of (reply.cids as string[] | undefined) ?? []) {
      setOf(took, id).add(cid);
      setOf(applied, id).add(cid);
      // Kept here, its chips Rust has waiting again were held back from the chip read: they show now.
      const kept = keptOf(id, cid);
      forget(id, cid);
      if (kept) keptChipsBack(id, kept);
    }
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
  return { draftOf, revOf, givenRefused, givenError, onGiven, resyncDraft, takeBack, keepDraft, moveDraft, oldProject, loadDraft };
}

export type Drafts = ReturnType<typeof draftState>;
