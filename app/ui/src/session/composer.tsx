import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Composer, ComposerCard, ComposerFooter, ComposerTools } from "../components/composer/composer";
import { isEmpty, plainText, sendMode } from "../components/composer/draft";
import { ComposerField, type ComposerFieldHandle } from "../components/composer/field";
import { QueueCard, type QueuedMessage } from "../components/composer/queue";
import { ComposerRail, PausedSendDialog } from "../components/composer/rail";
import { SendButton } from "../components/composer/send-button";
import { ErrorLine } from "../components/error-line";
import { UserBubble } from "../components/thread/message";
import { ask, type Row, threadSource } from "../daemon";
import type { Source } from "../thread/thread";
import { SessionLevel } from "./level";
import { SessionModel } from "./model";
import { newId } from "./store";

/** A session's row with what the composer needs from Rust: its queue, whether its agent can steer, whether a turn is open. */
export type ComposerRow = Row & {
  /** `error`: why Rust couldn't send it; the queue waits on it. `editing`: the message pulled back to edit, kept by Rust. */
  queue?: { paused: boolean; items: { id: string; text: string; error?: string }[]; editing?: { id: string; text: string; slot: number } | null } | null;
  steer?: boolean;
  running?: boolean;
};

/** Runs a brigadier command and answers its whole reply, a refusal included. */
export type Runner = (args: string[]) => Promise<Record<string, any>>;
const daemonRun: Runner = (args) => new Promise((resolve) => ask({ op: "run", args }, resolve));

const failure = (reply: Record<string, any>) => (reply.error === "disconnected" ? "Brigadier isn't running" : String(reply.message ?? reply.error ?? "Refused"));

/*
 * Messages sent at once or steered, shown in the thread at once [D30]. A message goes under its command id, so trying
 * it again can't send it twice (the host drops a repeated id). It settles when Rust's thread has it under that id: a
 * sent one's turn, a steer's message. A refusal stays, with Try again.
 */
type Sent = { cid: string; text: string; steer: boolean; error?: string };
let sent = new Map<string, Sent[]>();
const sentListeners = new Set<() => void>();
function setSent(id: string, change: (list: Sent[]) => Sent[]): void {
  sent = new Map(sent).set(id, change(sent.get(id) ?? []));
  for (const listener of sentListeners) listener();
}
const subscribeSent = (listener: () => void) => {
  sentListeners.add(listener);
  return () => sentListeners.delete(listener);
};

function deliver(run: Runner, id: string, message: Sent): void {
  const args = ["send", id, message.text, "--cid", message.cid];
  void run(message.steer ? [...args, "--steer"] : args).then((reply) => {
    // Logged: the thread shows the turn and how it ended, so the message has its place there.
    if (reply.ok || reply.result === "logged") return;
    setSent(id, (list) => list.map((each) => (each.cid === message.cid ? { ...each, error: failure(reply) } : each)));
  });
}

/** Whether the session has messages on their way (so the thread's footer shows them). */
export const useSending = (id: string) => useSyncExternalStore(subscribeSent, () => (sent.get(id)?.length ?? 0) > 0);

/** The messages on their way, under the thread's last row. */
export function SentBubbles({ id, source = threadSource, run = daemonRun }: { id: string; source?: Source; run?: Runner }) {
  const list = useSyncExternalStore(subscribeSent, () => sent.get(id));
  const session = useSyncExternalStore(source.subscribe, source.get);
  const ids = new Set([...(session?.turns.map((turn) => turn.id) ?? []), ...(session?.items.map((item) => ("cid" in item ? item.cid : undefined)) ?? [])]);
  const done = (each: Sent) => ids.has(each.cid);
  useEffect(() => {
    if (list?.some(done)) setSent(id, (now) => now.filter((each) => !done(each)));
  });
  const shown = list?.filter((each) => !done(each)) ?? [];
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {shown.map((each) => (
        <UserBubble
          key={each.cid}
          keep={each.cid}
          text={each.text}
          sending={!each.error}
          failed={each.error}
          onRetry={() => {
            const again = { ...each, error: undefined };
            setSent(id, (now) => now.map((one) => (one.cid === each.cid ? again : one)));
            deliver(run, id, again);
          }}
          onDiscard={() => setSent(id, (now) => now.filter((one) => one.cid !== each.cid))}
        />
      ))}
    </div>
  );
}

/** One queue action, shown at once until its reply is in and Rust's row has caught up with it (`touched`). */
type Op = { key: string; kind: "add" | "remove" | "resume" | "move"; qid: string; text?: string; slot?: number; at?: number; done?: () => void };

/**
 * The composer under a session's thread [D183, D188]: ⏎ sends, or while a turn runs queues (the fixed default until
 * wave 3, D191); ⌘⏎ or ⌥⏎ does the other, steering only where the agent can; ⌘⏎ in an empty field steers the first
 * queued message. Rust keeps the queue and sends it in order; Stop (■, Esc Esc) pauses it until Resume [D159].
 */
export function SessionComposer({ id, row, offline, run = daemonRun, source = threadSource }: { id: string; row: ComposerRow | undefined; offline: boolean; run?: Runner; source?: Source }) {
  const field = useRef<ComposerFieldHandle>(null);
  const [empty, setEmpty] = useState(true);
  const [ops, setOps] = useState<Op[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  // A queued message pulled back to edit, which Rust keeps meanwhile (`queue.editing`): sending puts it back in its
  // slot under its id, emptying the field puts the original back.
  const editing = useRef<{ qid: string; slot: number; text: string } | null>(null);
  // A send into the paused queue, asked about first.
  const [asking, setAsking] = useState<{ message: string; pulled: typeof editing.current } | null>(null);
  const kept = row?.queue?.editing;
  // Reopened (or after a restart), the message being edited is in the field again.
  useEffect(() => {
    const now = field.current;
    if (!kept || editing.current?.qid === kept.id || !now || !isEmpty({ parts: now.parts(), attachmentIds: [] })) return;
    editing.current = { qid: kept.id, slot: kept.slot, text: kept.text };
    now.set([kept.text]);
    setEmpty(!kept.text.trim());
  }, [kept?.id]);

  const running = row?.running === true;
  const canSteer = row?.steer === true;
  const touched = row?.touched ?? 0;
  const live = ops.filter((op) => op.at === undefined || touched < op.at);
  useEffect(() => {
    if (live.length === ops.length) return;
    ops.filter((op) => !live.includes(op)).forEach((op) => op.done?.());
    setOps(live);
  });

  let items: QueuedMessage[] = (row?.queue?.items ?? []).map((each) => ({ id: each.id, draft: { parts: [each.text], attachmentIds: [] }, state: "queued" }));
  let paused = row?.queue?.paused === true;
  for (const op of live) {
    if (op.kind === "remove") items = items.filter((each) => each.id !== op.qid);
    if (op.kind === "resume") paused = false;
    if (op.kind === "add" && !items.some((each) => each.id === op.qid)) {
      items = items.toSpliced(op.slot ?? items.length, 0, { id: op.qid, draft: { parts: [op.text ?? ""], attachmentIds: [] }, state: "local" });
    }
  }
  const text = (qid: string) => row?.queue?.items.find((each) => each.id === qid)?.text ?? live.find((op) => op.qid === qid)?.text ?? "";

  const act = (op: Omit<Op, "key">, args: string[], fail?: () => void) => {
    const key = newId();
    setOps((now) => [...now, { ...op, key }]);
    setError(null);
    void run(["queue", id, ...args]).then((reply) => {
      if (reply.ok) return setOps((now) => now.map((each) => (each.key === key ? { ...each, at: reply.at ?? 0 } : each)));
      setOps((now) => now.filter((each) => each.key !== key));
      setError(failure(reply));
      fail?.();
    });
  };
  const queue = (message: string, qid = newId(), slot?: number) =>
    act({ kind: "add", qid, text: message, slot }, slot === undefined ? ["add", message, "--qid", qid] : ["add", message, "--qid", qid, "--at", String(slot)]);
  const now = (message: string, steer = false) => {
    const entry: Sent = { cid: newId(), text: message, steer };
    setSent(id, (list) => [...list, entry]);
    deliver(run, id, entry);
  };
  const steerQueued = (qid: string) => act({ kind: "remove", qid }, ["steer", qid]);
  const edit = (qid: string) => {
    const slot = items.findIndex((each) => each.id === qid);
    const message = text(qid);
    editing.current = { qid, slot: Math.max(slot, 0), text: message };
    field.current?.set([message]);
    setEmpty(!message.trim());
    act({ kind: "remove", qid }, ["edit", qid], () => {
      editing.current = null;
      field.current?.set([]);
    });
  };

  const submit = (other: boolean) => {
    const parts = field.current?.parts() ?? [];
    if (offline) return;
    if (isEmpty({ parts, attachmentIds: [] })) {
      // ⌘⏎ with nothing typed steers the first queued message [D183].
      if (other && running && canSteer && items[0]?.state === "queued") steerQueued(items[0].id);
      return;
    }
    const message = plainText(parts);
    const pulled = editing.current;
    editing.current = null;
    field.current?.set([]);
    setEmpty(true);
    const mode = sendMode(running, "queue", other, canSteer);
    if (mode === "queue") return queue(message, pulled?.qid, pulled?.slot);
    if (mode === "now" && paused && items.length > 0) return setAsking({ message, pulled });
    sendNow(message, pulled, mode === "steer");
  };
  // Sent at once or steered, an edited message's kept copy goes.
  const sendNow = (message: string, pulled: typeof editing.current, steer = false) => {
    now(message, steer);
    if (pulled) act({ kind: "remove", qid: pulled.qid }, ["remove", pulled.qid]);
  };
  const changed = (blank: boolean) => {
    setEmpty(blank);
    const pulled = editing.current;
    if (!blank || !pulled) return;
    editing.current = null;
    act({ kind: "add", qid: pulled.qid, text: pulled.text, slot: pulled.slot }, ["restore"]);
  };
  const firstError = row?.queue?.items[0]?.error;
  const stop = () => {
    setStopError(null);
    void run(["stop", id]).then((reply) => !reply.ok && setStopError(failure(reply)));
  };
  const resume = () => act({ kind: "resume", qid: "" }, ["resume"]);
  const move = (qid: string, to: number) =>
    new Promise<void>((resolve, reject) => act({ kind: "move", qid, done: resolve }, ["move", qid, String(to)], reject));

  return (
    <Composer>
      <ComposerRail>
        <QueueCard
          items={items}
          paused={paused}
          resuming={live.some((op) => op.kind === "resume")}
          steer={canSteer && running}
          canEdit={empty}
          error={error ?? (firstError ? `Not sent: ${firstError}. Edit or delete it to go on.` : null)}
          onResume={resume}
          onSteer={steerQueued}
          onRemove={(qid) => act({ kind: "remove", qid }, ["remove", qid])}
          onEdit={edit}
          onMove={move}
        />
      </ComposerRail>
      <ComposerCard>
        <ComposerField
          ref={field}
          placeholder="Do anything"
          onChange={(parts) => changed(isEmpty({ parts, attachmentIds: [] }))}
          onSubmit={submit}
          onPullQueued={() => {
            const last = items.findLast((each) => each.state === "queued");
            if (!last) return false;
            edit(last.id);
            return true;
          }}
        />
        <ComposerFooter>
          <SessionLevel id={id} row={row} />
          <ComposerTools />
          <ErrorLine error={stopError} className="min-w-0 truncate" />
          <SessionModel id={id} row={row} offline={offline} />
          <SendButton empty={empty} running={running} canStop={running && !offline} blocked={offline ? "Reconnecting…" : undefined} onSend={() => submit(false)} onStop={stop} />
        </ComposerFooter>
      </ComposerCard>
      <PausedSendDialog
        waiting={asking === null ? null : items.length}
        onSendNow={() => {
          if (asking) sendNow(asking.message, asking.pulled);
          setAsking(null);
        }}
        onKeepPaused={() => {
          if (asking) queue(asking.message, asking.pulled?.qid, asking.pulled?.slot);
          setAsking(null);
        }}
        onClose={() => {
          if (asking === null) return;
          field.current?.set([asking.message]);
          editing.current = asking.pulled;
          setEmpty(false);
          setAsking(null);
          field.current?.focus();
        }}
      />
    </Composer>
  );
}
