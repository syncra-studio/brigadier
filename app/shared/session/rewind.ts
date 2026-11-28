// Rust's rewind preview as both apps read it, and the rewind's words [D384, D481].
import { files, named } from "../words";

/**
 * Rust's answer: what a restore would put back and leave alone. No paths, no file choice [D481]. `sharer`: the files
 * stay because another session in this folder worked during these turns, or works now [D1078]. `nested`: the
 * nested repositories among `leftOut`. `why`: Rust's reason only keep is offered, when it has one [D384]. `stale`: a
 * folder chat's repos missing a snapshot of one of these turns, which stay as they are [D3105].
 */
export type RewindPreview = { paths: string[]; hand: string[]; leftOut: string[]; nested: string[]; stale?: string[]; commits: boolean; error?: string; sharer?: { id: string; now: boolean }; why?: string };

/** Why a rewind's command was refused, or its answer lost. */
export const why = (reply: Record<string, any>) => (reply.error === "disconnected" ? "Brigadier isn't running, so the outcome isn't known yet." : String(reply.message ?? reply.error ?? "Refused"));

export function previewOf(reply: Record<string, any>): RewindPreview {
  const none = { paths: [], hand: [], leftOut: [], nested: [], commits: false };
  if (!reply.ok) return { ...none, error: why(reply) };
  if (reply.restore === true) return { paths: reply.paths ?? [], hand: reply.hand ?? [], leftOut: reply.leftOut ?? [], nested: reply.nested ?? [], stale: reply.stale ?? [], commits: reply.commits === true };
  // Another session in the folder keeps the files [D1078]; else Rust's reason [D384].
  return typeof reply.with === "string" ? { ...none, sharer: { id: reply.with, now: reply.why === "busy" } } : { ...none, why: String(reply.why) };
}

/** The rewind dialog's words. */
export const REWIND_WORDS = {
  title: "Rewind to this message?",
  back: "The chat goes back to just before this message.",
  returns: "Your message returns to the composer.",
  confirm: "Rewind",
  keep: "Keep files as they are",
  keepNote: "Only the chat goes back.",
  restore: "Undo the agent's file changes",
  undoes: (paths: string[]) => `Undoes ${files(paths.length)} changed during these turns: ${named(paths)}.`,
  // Snapshots can't tell who wrote a file mid-turn, so your edits then are in it [C98].
  yours: "Edits you made while the agent worked are included, and Redo brings them back.",
  // Snapshots keep no ignored files, so which ones changed can't be said [D1192].
  ignored: "Ignored files (like .env) aren't in snapshots and stay as they are.",
  commits: "Commits made since then stay.",
  nothingBack: "Files stay: nothing the agent changed can go back.",
  // Proposed words, shown to the owner on screen [D1078].
  sharer: (name: string | undefined, now: boolean) => `Files stay: ${name ?? "another session"} ${now ? "is working in this folder now" : "was working in this folder during this turn"}.`,
  redo: "Redo file changes",
  puttingBack: "Putting the agent's changes back…",
};

/** What stays as it is, a line each: edited since, too big to keep, nested repositories, repos with no snapshot. */
export const staysWords = ({ hand, big, nested, stale = [] }: { hand: string[]; big: string[]; nested: string[]; stale?: string[] }) =>
  [
    hand.length > 0 && `Left as you edited them: ${named(hand)}.`,
    big.length > 0 && `Too big to go back: ${named(big)}.`,
    nested.length > 0 && `Nested repositories stay as they are: ${named(nested)}.`,
    stale.length > 0 && `No snapshot was taken of these repos for every turn, so they stay as they are: ${named(stale)}.`,
  ].filter((line): line is string => Boolean(line));

/** What came of a rewind, in its toast. */
export function rewoundWords(reply: Record<string, any>, restore: boolean): string {
  if (reply.already) return "Rewound · check your files";
  if (!restore) return "Rewound · your files are as they were";
  const count = `${reply.restored} ${reply.restored === 1 ? "file" : "files"} undone`;
  return reply.complete === false ? `Rewound · ${count}, some stayed as they are` : `Rewound · ${count}`;
}

/** What came of Redo file changes: what came back, and what stayed as edited since; or why not. */
export const redoneWords = (reply: Record<string, any>) => {
  if (!reply.ok) return `Couldn't put the agent's changes back: ${why(reply)}`;
  const kept: string[] = reply.kept ?? [];
  const back = `The agent's changes are back · ${files(reply.undone)}`;
  // Proposed words: what changed since the restore keeps its edit [D1192].
  return kept.length > 0 ? `${back}, kept as edited since: ${named(kept)}` : back;
};
