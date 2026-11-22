import { useEffect, useSyncExternalStore } from "react";

import type { Draft } from "../components/composer/draft";
import type { SlashCommand } from "../components/composer/menus";
import { StartedLine, type StartedStatus } from "../components/thread/started";
import { ask, threadSource, useDaemon } from "../daemon";
import { sessionId } from "../home/start";
import { store } from "../onboarding/api";
import type { Item } from "../thread/item";
import { newId } from "./store";

/*
 * Send as new [D183, D204, D205, D206]: the message starts a new session in this one's project and the user stays.
 * Rust logs the operation in this session first and its result after, and the thread draws that as one row by the new
 * session's id [D65]. Until the row is in the open thread, the line shows from here at once [D30]; a reply lost with
 * the link is asked again under the same ids, which Rust carries on from its logs [D54].
 */

/** Brigadier's own `/` command, the only one until wave 3 [D164]: a chip in the text, so the message says where it goes. */
export const NEW_SESSION: SlashCommand = { id: "new-session", kind: "command", label: "/new", description: "Send the message as a new session, and stay here", instant: false };

type Pending = { source: string; id: string; cid: string; text: string; title: string; qid?: string; parts?: string; asking: boolean; unknown?: boolean; landed?: boolean; error?: string };
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
function run(entry: Pending): void {
  put(entry.id, { asking: true, unknown: false, error: undefined });
  if (!entry.title) ask({ op: "run", args: ["title", entry.text] }, (reply) => reply.ok && put(entry.id, { title: reply.title }));
  const args = ["side", entry.source, entry.id, "--text", entry.text, "--cid", entry.cid, ...(entry.qid ? ["--qid", entry.qid] : []), ...(entry.parts ? ["--parts", entry.parts] : [])];
  ask({ op: "run", args }, (reply) => {
    if (!get(entry.id)) return;
    if (reply.error === "disconnected") return put(entry.id, { asking: false, unknown: true });
    // With `session`, Rust logged it and the source's row says how it went; without, nothing was made or logged.
    put(entry.id, { asking: false, landed: true, error: reply.session ? undefined : String(reply.message ?? reply.error ?? "Refused") });
  });
}

/** Starts `text` as a new session from session `source`; `qid`: the queued message it was edited from [D237];
 * `made`: its new session's id and the message's, when chips were handed to it first. */
export function sendAsNew(source: string, text: string, qid?: string, made = { id: sessionId(), cid: newId() }, parts?: string): void {
  const entry: Pending = { source, ...made, text, title: "", qid, parts, asking: true };
  pending.set(new Map(pending.get()).set(entry.id, entry));
  run(entry);
}

// Put back: the text, and the draft it was sent from, go to the composer of the session it came from.
const back = store<{ source: string; text: string; n: number; above: boolean; draft?: Draft | null } | null>(null);
export const putBack = (source: string, text: string, above = false, draft?: Draft | null) => back.set({ source, text, above, draft, n: (back.get()?.n ?? 0) + 1 });

/** The last put back, without taking it: the PR page's review chat comes forward for one [D237]. */
export const usePutBackAsked = () => back.use();

/** Fills session `id`'s composer when one of its lines puts a message back. */
export function usePutBack(id: string, fill: (text: string, above: boolean, draft?: Draft | null) => void): void {
  const asked = back.use();
  useEffect(() => {
    if (asked?.source !== id) return;
    fill(asked.text, asked.above, asked.draft);
    // Taken once: the composer mounts again each time its session opens.
    back.set(null);
  }, [asked?.n]);
}

/** This session's lines not yet in its open thread, so the footer shows them. */
function useMine(source: string): Pending[] {
  const all = pending.use();
  const session = useSyncExternalStore(threadSource.subscribe, threadSource.get);
  const inThread = (entry: Pending) => session?.id === source && session.items.some((item) => item.id === `side:${entry.id}`);
  // Settled on the source's own row [D204]: once it's in the open thread, or answered while this thread isn't open.
  useEffect(() => {
    for (const entry of all.values()) if (inThread(entry) || (entry.landed && !entry.error && session?.id !== entry.source)) put(entry.id, null);
  });
  return [...all.values()].filter((entry) => entry.source === source && !inThread(entry));
}

export const useSidePending = (source: string): boolean => useMine(source).length > 0;

/** The lines from here under the thread's last row, until Rust's row stands in for each. */
export function PendingSideLines({ source }: { source: string }) {
  const { daemon } = useDaemon();
  const mine = useMine(source);
  useEffect(() => {
    if (daemon) for (const entry of mine) if (entry.unknown && !entry.asking) run(entry);
  }, [daemon]);
  return mine.map((entry) => (
    <StartedLine
      key={entry.id}
      title={entry.title}
      starting
      error={entry.error}
      onPutBack={() => {
        put(entry.id, null);
        putBack(source, entry.text, false, entry.parts ? JSON.parse(entry.parts) : null);
      }}
    />
  ));
}

const STATUS: Record<string, StartedStatus> = { working: "working", needs: "needs", amber: "failed" };
type Started = Extract<Item, { kind: "started" }>;
const asked = new Set<string>();

/**
 * Rust's row for a session started from this one: its title and live status from that session's row, Open to go
 * there; a failed start says why and what stayed, with Put back [D204, D35]. PROPOSED: an intent with no result
 * (a crash in between) is asked again once per app run, while this thread is open.
 */
export function SideLine({ item }: { item: Started }) {
  const { daemon, rows } = useDaemon();
  const source = useSyncExternalStore(threadSource.subscribe, threadSource.get)?.id;
  const local = pending.use().get(item.session);
  const busy = local?.asking;
  useEffect(() => {
    if (item.state !== "starting" || !daemon || !source || busy || asked.has(item.session)) return;
    asked.add(item.session);
    ask({ op: "run", args: ["side", source, item.session] });
  }, [item.state, daemon, source, busy]);
  if (item.state === "failed") {
    const left = item.left?.length ? ` · left behind: ${item.left.join(", ")}` : "";
    return <StartedLine title="" error={`${item.error ?? "Refused"}${left}`} onPutBack={source && item.text ? () => putBack(source, item.text!) : undefined} />;
  }
  const row = rows?.find((each) => each.id === item.session);
  // PROPOSED: any mark but working, needs and amber reads Done; no row (deleted) shows no status [D204].
  const status = item.state === "started" && row ? (STATUS[row.mark ?? ""] ?? "done") : undefined;
  return (
    <StartedLine
      title={row?.title || item.title || local?.title || ""}
      base={item.base}
      starting={item.state === "starting"}
      status={status}
      onOpen={() => (window.location.hash = `#thread/${encodeURIComponent(item.session)}`)}
    />
  );
}
