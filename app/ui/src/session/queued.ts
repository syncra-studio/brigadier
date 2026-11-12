import type { Draft } from "../components/composer/draft";
import type { QueuedMessage } from "../components/composer/queue";
import type { Row } from "../daemon";

/** A message in Rust's queue: `origin` names another session's; `to` the user's for one of this session's workers. */
export type RustQueued = { id: string; text: string; parts?: Draft; error?: string; origin?: string; to?: string };

/**
 * Rust's queue as the card's rows: another session's message without the envelope's first line, with who sent it
 * [D3014]; one for a worker with its name, "To ‹name›" [D3050].
 */
export function queuedOf(items: readonly RustQueued[], rows: readonly Row[]): QueuedMessage[] {
  const title = (id: string) => rows.find((r) => r.id === id)?.title ?? null;
  return items.map((each) => {
    const to = each.to ? { to: { name: title(each.to) } } : {};
    const peer = each.origin?.startsWith("peer:") && each.origin.slice(5);
    if (!peer) return { id: each.id, draft: each.parts ?? { parts: [each.text], attachmentIds: [] }, state: "queued", ...to };
    const at = each.text.indexOf("]\n\n");
    const words = at < 0 ? each.text : each.text.slice(at + 3);
    return { id: each.id, draft: { parts: [words], attachmentIds: [] }, state: "queued", peer: { title: title(peer) } };
  });
}

/**
 * The command for the user's message to `worker`, one of session `id`'s: steered, into the worker's turn; else to
 * Rust, which gives it at once or holds it in the session's queue until that worker's turn is over, an edited one in
 * its slot (`at`) [D3006, D3050].
 */
export function toArgs(id: string, worker: string, message: string, slot: { qid: string; slot?: number }, steer: boolean, draft?: string): string[] {
  if (steer) return ["send", worker, message, "--cid", slot.qid, "--steer", ...(draft ? ["--parts", draft, "--from", id] : [])];
  const at = slot.slot === undefined ? [] : ["--at", String(slot.slot)];
  return ["queue", id, "add", message, "--qid", slot.qid, "--to", worker, ...at, ...(draft ? ["--parts", draft] : [])];
}
