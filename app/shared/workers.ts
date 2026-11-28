// The words a session's workers and subagents read in, for both apps [D58].
import type { Item, Progress } from "./thread";
import type { WorkerStateKind } from "./rows";

/** A worker as a sentence names it: its name, and its state's kind and word ("Needs you"). */
type Named = { name: string; kind: WorkerStateKind; word: string };

const FINISHED: ReadonlySet<WorkerStateKind> = new Set(["paused", "failed", "stopped", "merged", "doneNotMerged", "done"]);

/** Whether it's finished: the Done section's, not the strip's. */
export const finished = (worker: { kind: WorkerStateKind }) => FINISHED.has(worker.kind);

/** Whether the strip and End hold it: at work, waiting, or paused, its toggle resuming it. */
export const onHand = (worker: { kind: WorkerStateKind }) => worker.kind === "paused" || !finished(worker);

/** A state word inside a line: "Needs you" reads "needs you". */
export const lowerFirst = (word: string) => word.charAt(0).toLowerCase() + word.slice(1);

/** A worker the app no longer has. */
export const UNKNOWN_WORKER = "a worker";

/** A batch's names as its row says them: past three, the first two and how many more, which its list names. */
export const batchSplit = <T>(workers: readonly T[]) => {
  const named = workers.length > 3 ? workers.slice(0, 2) : workers;
  return { named, more: workers.length - named.length };
};
export const moreWords = (more: number) => `${more} more`;
/** What goes before the `at`-th of `count` names: ", ", or " and " before the last. */
export const nameJoin = (at: number, count: number) => (at === 0 ? "" : at === count - 1 ? " and " : ", ");

/** "A", "A and B", "A, B and C"; past three, "A, B and 4 more": a batch row's words, its list naming each. */
export const batchNames = (workers: readonly Named[]) => {
  const { named, more } = batchSplit(workers);
  const names = [...named.map((worker) => worker.name), ...(more > 0 ? [moreWords(more)] : [])];
  return names.map((name, at) => nameJoin(at, names.length) + name).join("");
};

const FINISHED_KINDS: ReadonlySet<WorkerStateKind> = new Set(["merged", "doneNotMerged", "done"]);

/**
 * How the batch went: working while any is on hand, else finished, with errors when one failed.
 * Workers whose End has its own "Ended" row (`endRows`) keep their start, so the end reads once, in its place [D328].
 */
export function batchWords(workers: readonly { kind: WorkerStateKind }[], endRows = false): string {
  if (workers.some(onHand)) return "started working";
  if (workers.some((worker) => worker.kind === "failed")) return "finished with errors";
  if (workers.some((worker) => FINISHED_KINDS.has(worker.kind))) return "finished";
  return endRows ? "started working" : "stopped";
}

/** One agent's own outcome in the opened batch: a worker's merge said there alone [D175]. */
export function outcomeWords(worker: Named): string {
  switch (worker.kind) {
    case "working":
      return "started working";
    case "merged":
      return `finished · ${worker.word}`;
    case "doneNotMerged":
      return "finished · Not merged";
    case "done":
      return "finished";
    default:
      return lowerFirst(worker.word);
  }
}

/** The lead's step on its team, before the names: the user's own End says so; ending reads "Ended" (D199, D3041). */
export const teamStepVerb = (step: { type: "messaged" | "stopped" | "paused" | "resumed"; byUser?: boolean }) =>
  step.type === "messaged" ? (step.byUser ? "You messaged" : "Messaged") : step.type === "stopped" ? (step.byUser ? "You ended" : "Ended") : step.type === "paused" ? "Paused" : "Resumed";

/** "2 workers still running": Stop ended the parent's turn only [D3009, D3011]. */
export const stillRunning = (n: number) => `${n} ${n === 1 ? "worker" : "workers"} still running`;

const SUBAGENT_STATES: Record<Progress, [WorkerStateKind, string]> = {
  pending: ["working", "Waiting"],
  running: ["working", "Working"],
  done: ["done", "Done"],
  failed: ["failed", "Failed"],
  cancelled: ["stopped", "Stopped"],
};

/** A subagent's row as a worker: its row's id (its glyph never changes as its own id comes in), its task as its name [D78, D115]. */
export function subagentOf(item: Extract<Item, { kind: "childAgent" }>) {
  const [kind, word] = SUBAGENT_STATES[item.progress];
  return { id: item.id, name: item.title || "A subagent", kind, word, startedAt: item.startedAt ?? 0, lastAt: item.endedAt ?? undefined };
}
