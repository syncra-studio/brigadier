import type { Draft } from "../components/composer/draft";
import type { QueuedMessage } from "../components/composer/queue";
import type { Row } from "../daemon";
import type { Session } from "../thread/item";

/** A message in Rust's queue: `origin` names another session's; `to` the user's for one of this session's workers. */
export type RustQueued = { id: string; text: string; parts?: Draft; error?: string; origin?: string; to?: string; deciding?: boolean; /** The user's `!` command: waiting to run, or ended and its report waiting to go. */ shell?: "wait" | "ended" };

/**
 * Rust's queue as the card's rows: another session's message without the envelope's first line, with who sent it
 * [D3014]; one for a worker with its name, "To ‹name›" [D3050], and whether it ended [D96].
 */
export function queuedOf(items: readonly RustQueued[], rows: readonly Row[]): QueuedMessage[] {
  const title = (id: string) => {
    const row = rows.find((r) => r.id === id);
    return row ? row.title || "New session" : null;
  };
  return items.map((each) => {
    // Rust's error on one for a worker: that worker has ended [D96].
    const to = each.to ? { to: { name: title(each.to), ended: each.error !== undefined } } : {};
    if (each.shell) {
      const line = each.shell === "ended" ? (each.parts?.shell ?? each.text) : each.text;
      return { id: each.id, draft: { parts: [line], attachmentIds: [] }, state: each.shell === "ended" ? "delivered" : "queued", shell: true, refused: each.error !== undefined };
    }
    const peer = each.origin?.startsWith("peer:") && each.origin.slice(5);
    if (!peer) return { id: each.id, draft: each.parts ?? { parts: [each.text], attachmentIds: [] }, state: each.deciding ? "deciding" : "queued", ...to };
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

const held = new WeakMap<Session, ReadonlySet<string | undefined>>();

/**
 * The command ids a thread holds, its turns' and its messages', once per snapshot. A message there has left the queue
 * and its bubble, even before Rust's row says so: it never shows twice [D30].
 */
export function inThread(session: Session | null): ReadonlySet<string | undefined> {
  if (!session) return new Set();
  const ids = held.get(session) ?? new Set([...session.turns.map((turn) => turn.id), ...session.items.map((item) => ("cid" in item ? item.cid : undefined))]);
  held.set(session, ids);
  return ids;
}
