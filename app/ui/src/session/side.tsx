import { useEffect, useSyncExternalStore } from "react";

import type { Draft } from "../components/composer/draft";
import type { SlashCommand } from "../components/composer/menus";
import { StartedLine, type StartedStatus } from "../components/thread/started";
import { threadSource, useDaemon } from "../daemon";
import { sessionId } from "../home/start";
import type { Item } from "../thread/item";
import { type Pending, sideState, type Swap } from "../../../shared/session/side";
import { daemonRun } from "./composer";
import { newId } from "./store";
import { NEW_SESSION_WORDS } from "../../../shared/session/composer";

// Send as new's logic is app/shared/session/side.ts [D58]; its lines and hooks are here.

/** Brigadier's own `/` command, the only one until wave 3 [D164]: a chip in the text, so the message says where it goes. */
export const NEW_SESSION: SlashCommand = { id: "new-session", kind: "command", ...NEW_SESSION_WORDS, instant: false };

const side = sideState();
const usePending = () => useSyncExternalStore(side.pending.subscribe, side.pending.get);
const { put } = side;
export const { putBack } = side;

/** Starts `text` as a new session from session `source`; `qid`: the queued message it was edited from [D237];
 * `made`: its new session's id and the message's, when chips were handed to it first. */
export const sendAsNew = (source: string, text: string, qid?: string, made = { id: sessionId(), cid: newId() }, parts?: string) => side.sendAsNew(daemonRun, source, text, qid, made, parts);

/** The last put back, without taking it: the PR page's review chat comes forward for one [D237]. */
export const usePutBackAsked = () => useSyncExternalStore(side.back.subscribe, side.back.get);

/** Fills session `id`'s composer when one of its lines puts a message back. */
export function usePutBack(id: string, fill: (text: string, above: boolean, draft?: Draft | null, swap?: Swap) => void): void {
  const asked = usePutBackAsked();
  useEffect(() => {
    if (asked?.source !== id) return;
    fill(asked.text, asked.above, asked.draft, asked.swap);
    // Taken once: the composer mounts again each time its session opens.
    side.back.set(null);
  }, [asked?.n]);
}

/** This session's lines not yet in its open thread, so the footer shows them. */
function useMine(source: string): Pending[] {
  const all = usePending();
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
    if (daemon) side.rerun(daemonRun, mine);
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

/**
 * Rust's row for a session started from this one: its title and live status from that session's row, Open to go
 * there; a failed start says why and what stayed, with Put back [D204, D35]. PROPOSED: an intent with no result
 * (a crash in between) is asked again once per app run for Send as new, while this thread is open.
 */
export function SideLine({ item }: { item: Started }) {
  const { daemon, rows } = useDaemon();
  const source = useSyncExternalStore(threadSource.subscribe, threadSource.get)?.id;
  const local = usePending().get(item.session);
  const busy = local?.asking;
  useEffect(() => {
    if (item.state !== "starting" || !item.replay || !daemon || !source || busy) return;
    side.replay(daemonRun, source, item.session);
  }, [item.state, item.replay, daemon, source, busy]);
  if (item.state === "failed") {
    const left = item.left?.length ? ` · left behind: ${item.left.join(", ")}` : "";
    return <StartedLine title={item.title ?? ""} error={`${item.error ?? "Refused"}${left}`} onPutBack={source && item.text ? () => putBack(source, item.text!) : undefined} />;
  }
  const row = rows?.find((each) => each.id === item.session);
  // PROPOSED: any mark but working, needs and amber reads Done, or Stopped once the user stopped it [C99]; no row
  // (deleted) shows no status [D204].
  const status = item.state === "started" && row ? (STATUS[row.mark ?? ""] ?? (row.state === "stopped" ? "stopped" : "done")) : undefined;
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
