// shortcut: a stand-in for the Rust daemon, so every state can be triggered by hand; goes once the foundation speaks the boundary.
import type { Item } from "../thread/item";
import type { Backend, Command, Frame, Link, Outcome, Row, Run } from "./boundary";

export type FakeCommand = { text: string };

/** What the demo's controls change. Each `next…` acts once, then turns itself off. */
export type Knobs = {
  delayMs: number;
  reorder: boolean;
  failNext: boolean;
  loseNextSend: boolean;
  dropAfterNextSend: boolean;
  loseNextFrame: boolean;
};

type Event = Exclude<Frame<Item>["type"], "snapshot">;
type Unsequenced = { [T in Event]: Omit<Extract<Frame<Item>, { type: T }>, "seq"> }[Event];

/** How a send looks before the backend has it. */
export function preview(clientId: string, text: string): Item {
  return { id: clientId, turnId: "", kind: "message", role: "user", text, streaming: false };
}

const REPLY = "Here is what I found. The change is small: one function, and its two callers. I'll make it now and run the checks once it's in.";
const TOKEN_MS = 70;
const RECONNECT_MS = 1500;
const DAEMON_RETRY_MS = 3000;

export function createFake() {
  const knobs: Knobs = { delayMs: 150, reorder: false, failNext: false, loseNextSend: false, dropAfterNextSend: false, loseNextFrame: false };
  let rows: Row<Item>[] = [];
  let run: Run = { state: "idle" };
  let seq = 0;
  const receipts = new Map<string, Outcome>();
  // Ids answered `unseen`: refused from now on, which is what makes `unseen` true.
  const refused = new Set<string>();
  let link: Link = "connecting";
  let daemonUp = true;
  let stream: { ask: () => string[]; onFrame: (frame: Frame<Item>) => void; onLink: (link: Link) => void } | null = null;
  let streaming: ReturnType<typeof setInterval> | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const later = (ms: number, then: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      then();
    }, ms);
    timers.add(timer);
  };

  function setLink(next: Link): void {
    link = next;
    stream?.onLink(next);
  }

  function deliver(frame: Frame<Item>): void {
    if (link !== "live" || !stream) return;
    const to = stream;
    if (frame.type !== "snapshot" && knobs.loseNextFrame) {
      knobs.loseNextFrame = false;
      return;
    }
    const extra = knobs.reorder && frame.type !== "snapshot" ? Math.random() * 400 : 0;
    if (extra === 0) to.onFrame(frame);
    else later(extra, () => link === "live" && stream === to && to.onFrame(frame));
  }

  function emit(frame: Unsequenced): void {
    seq += 1;
    deliver({ ...frame, seq } as Frame<Item>);
  }

  function put(row: Row<Item>): void {
    const at = rows.findIndex((each) => each.item.id === row.item.id);
    rows = at === -1 ? [...rows, row] : rows.with(at, row);
    emit({ type: "put", row });
  }

  function setRun(next: Run, cause: string | null = null): void {
    run = next;
    emit({ type: "run", run, cause });
  }

  function open(): void {
    if (!stream) return;
    if (!daemonUp) {
      setLink("reconnecting");
      later(DAEMON_RETRY_MS, () => !daemonUp && setLink("disconnected"));
      return;
    }
    const to = stream;
    later(knobs.delayMs, () => {
      if (stream !== to || !daemonUp) return;
      const outcomes: Record<string, Outcome> = {};
      for (const id of to.ask()) {
        const known = receipts.get(id);
        if (!known) refused.add(id);
        outcomes[id] = known ?? { kind: "unseen" };
      }
      setLink("live");
      deliver({ type: "snapshot", seq, rows, run, outcomes });
    });
  }

  function stopStreaming(): void {
    clearInterval(streaming);
    streaming = undefined;
    const last = rows.at(-1);
    if (last?.item.kind === "message" && last.item.streaming) put({ ...last, item: { ...last.item, streaming: false } });
  }

  /** A new message lands after the reply in progress, so that reply ends first, whole. */
  function finishReply(): void {
    const last = rows.at(-1);
    if (!streaming || last?.item.kind !== "message") return;
    clearInterval(streaming);
    streaming = undefined;
    put({ ...last, item: { ...last.item, text: REPLY, streaming: false } });
  }

  function reply(turnId: string, cause: string): void {
    setRun({ state: "working" }, cause);
    const id = crypto.randomUUID();
    const words = REPLY.split(" ");
    let shown = 0;
    streaming = setInterval(() => {
      shown += 1;
      put({ clientId: null, item: { id, turnId, kind: "message", role: "assistant", text: words.slice(0, shown).join(" "), streaming: shown < words.length } });
      if (shown < words.length) return;
      clearInterval(streaming);
      streaming = undefined;
      setRun({ state: "idle" });
    }, TOKEN_MS);
  }

  function receive({ clientId, command }: Command<FakeCommand>): void {
    if (refused.has(clientId)) return;
    const known = receipts.get(clientId);
    if (known?.kind === "rejected") emit({ type: "rejected", clientId, error: known.error });
    if (known) return;
    if (knobs.failNext) {
      knobs.failNext = false;
      const error = "The agent refused it: its provider answered 529, overloaded.";
      receipts.set(clientId, { kind: "rejected", error });
      emit({ type: "rejected", clientId, error });
      return;
    }
    receipts.set(clientId, { kind: "applied" });
    finishReply();
    const turnId = crypto.randomUUID();
    put({ clientId, item: { id: crypto.randomUUID(), turnId, kind: "message", role: "user", text: command.text, streaming: false } });
    reply(turnId, clientId);
  }

  const backend: Backend<Item, FakeCommand> = {
    connect(ask, onFrame, onLink) {
      // While live (a resync after a gap), the link stays up and only a fresh snapshot follows.
      stream = { ask, onFrame, onLink };
      open();
    },
    send(command) {
      if (link !== "live") return;
      if (knobs.loseNextSend) {
        // Lost on the way, and the link with it: the UI can't tell whether it arrived.
        knobs.loseNextSend = false;
        dropLink();
        return;
      }
      later(knobs.delayMs, () => {
        if (!daemonUp) return;
        if (knobs.dropAfterNextSend) {
          // It arrives and runs, but the link goes before any answer reaches the UI.
          knobs.dropAfterNextSend = false;
          dropLink();
        }
        receive(command);
      });
    },
  };

  function dropLink(): void {
    if (link === "disconnected" || !stream) return;
    setLink("reconnecting");
    later(RECONNECT_MS, open);
  }

  return {
    backend,
    knobs,
    dropLink,
    killDaemon(): void {
      daemonUp = false;
      setLink("reconnecting");
      stopStreaming();
      // Back up, it finds the run it was in the middle of cut off.
      if (run.state === "working" || run.state === "stalled") run = { state: "interrupted" };
      later(DAEMON_RETRY_MS, () => !daemonUp && setLink("disconnected"));
    },
    startDaemon(): void {
      daemonUp = true;
      open();
    },
    stall(): void {
      clearInterval(streaming);
      streaming = undefined;
      setRun({ state: "stalled" });
    },
    interrupt(): void {
      stopStreaming();
      setRun({ state: "interrupted" });
    },
    fail(): void {
      stopStreaming();
      setRun({ state: "error", error: "The agent's process exited with code 1." });
    },
    clear(): void {
      stopStreaming();
      for (const row of rows) emit({ type: "drop", id: row.item.id });
      rows = [];
      setRun({ state: "idle" });
    },
    /** Forgets the open stream, as a closed window would. */
    close(): void {
      stream = null;
      link = "connecting";
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

export type Fake = ReturnType<typeof createFake>;
