import type { Draft } from "../draft";
import { store } from "../store";
import type { Runner } from "./run";

/*
 * Send as new [D183, D204, D205, D206]: the message starts a new session in this one's project and the user stays.
 * Rust logs the operation in this session first and its result after, and the thread draws that as one row by the new
 * session's id [D65]. Until the row is in the open thread, the line shows from here at once [D30]; a reply lost with
 * the link is asked again under the same ids, which Rust carries on from its logs [D54].
 */

export type Pending = { source: string; id: string; cid: string; text: string; title: string; qid?: string; parts?: string; asking: boolean; unknown?: boolean; landed?: boolean; error?: string };
/** Words an earlier put back left in the composer, and what takes their place there; gone from it, the text goes in as any. */
export type Swap = { was: string; now: string };
export type Back = { source: string; text: string; n: number; above: boolean; draft?: Draft | null; swap?: Swap } | null;

/** A new session's id, made here so its row and thread show before Rust has it [D30]. */
export const sessionId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
/** The command that starts a send as new, or carries on with what Rust's logs hold for it. */
export const sideArgs = (entry: Pick<Pending, "source" | "id" | "text" | "cid" | "qid" | "parts">) => [
  "side",
  entry.source,
  entry.id,
  "--text",
  entry.text,
  "--cid",
  entry.cid,
  ...(entry.qid ? ["--qid", entry.qid] : []),
  ...(entry.parts ? ["--parts", entry.parts] : []),
];

/**
 * One Mac's sends as new and put backs [D58]. Asking again what a lost reply left unknown (`rerun`) and a start logged
 * with no result (`replay`) are each app's choice: the desktop calls them, a phone doesn't, as nothing resends by itself there.
 */
export function sideState() {
  const pending = store<ReadonlyMap<string, Pending>>(new Map());
  const get = (id: string) => pending.get().get(id);
  function put(id: string, change: Partial<Pending> | null): void {
    const next = new Map(pending.get());
    const now = next.get(id);
    if (change === null) next.delete(id);
    else if (now) next.set(id, { ...now, ...change });
    pending.set(next);
  }

  /** Asks Rust to start it, or to carry on with what its logs already hold for it. */
  function start(run: Runner, entry: Pending): void {
    put(entry.id, { asking: true, unknown: false, error: undefined });
    if (!entry.title) void run(["title", entry.text]).then((reply) => reply.ok && put(entry.id, { title: reply.title }));
    void run(sideArgs(entry)).then((reply) => {
      if (!get(entry.id)) return;
      if (reply.error === "disconnected") return put(entry.id, { asking: false, unknown: true });
      // With `session`, Rust logged it and the source's row says how it went; without, nothing was made or logged.
      put(entry.id, { asking: false, landed: true, error: reply.session ? undefined : String(reply.message ?? reply.error ?? "Refused") });
    });
  }

  /** Starts `text` as a new session from session `source` under the ids `made`; `qid`: the queued message it was edited from [D237]. */
  function sendAsNew(run: Runner, source: string, text: string, qid: string | undefined, made: { id: string; cid: string }, parts?: string): void {
    const entry: Pending = { source, ...made, text, title: "", qid, parts, asking: true };
    pending.set(new Map(pending.get()).set(entry.id, entry));
    start(run, entry);
  }

  // Put back: the text, and the draft it was sent from, go to the composer of the session it came from.
  const back = store<Back>(null);
  const putBack = (source: string, text: string, above = false, draft?: Draft | null, swap?: Swap) => back.set({ source, text, above, draft, swap, n: (back.get()?.n ?? 0) + 1 });

  /** Each line whose answer was lost with the link, asked again: on a new connection. */
  const rerun = (run: Runner, entries: readonly Pending[]) => {
    for (const entry of entries) if (entry.unknown && !entry.asking) start(run, entry);
  };
  const replayed = new Set<string>();
  /** A start logged with no result (a crash in between), asked again once per app run. */
  const replay = (run: Runner, source: string, session: string) => {
    if (replayed.has(session)) return;
    replayed.add(session);
    void run(["side", source, session]);
  };

  return { pending, put, sendAsNew, back, putBack, rerun, replay };
}
