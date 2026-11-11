import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { Composer, ComposerCard, ComposerFooter, ComposerTools } from "../components/composer/composer";
import { type Draft, isEmpty, plainText, sendMode } from "../components/composer/draft";
import { ComposerField, type ComposerFieldHandle } from "../components/composer/field";
import { QueueCard, type QueuedMessage } from "../components/composer/queue";
import { ComposerRail, PausedSendDialog } from "../components/composer/rail";
import { SendButton } from "../components/composer/send-button";
import { ErrorLine } from "../components/error-line";
import { UserBubble, datedAfter } from "../components/thread/message";
import { ask, type Row, threadSource } from "../daemon";
import { sessionId } from "../home/start";
import { type Chip, dropChips, handOff, leaveChips, restoreChips, useChips, withChips } from "../panel/chips";
import { CommentChip } from "../review/comments";
import type { Source } from "../thread/thread";
import { sendFailed } from "../thread/follow";
import { answeringSource, SessionApprovals, SessionQuestions, useApprovalWaiting } from "./decisions";
import { SessionLevel } from "./level";
import { SessionModel } from "./model";
import { SessionNotices } from "./notices";
import { draftOf, keepDraft, loadDraft } from "./draft";
import { NEW_SESSION, sendAsNew, usePutBack } from "./side";
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
export const daemonRun: Runner = (args) => new Promise((resolve) => ask({ op: "run", args }, resolve));

const failure = (reply: Record<string, any>) => (reply.error === "disconnected" ? "Brigadier isn't running" : String(reply.message ?? reply.error ?? "Refused"));

/*
 * Messages sent at once or steered, shown in the thread at once [D30]. A message goes under its command id, so trying
 * it again can't send it twice (the host drops a repeated id). It settles when Rust's thread has it under that id: a
 * sent one's turn, a steer's message. A refusal stays, with Try again.
 */
type Sent = { cid: string; text: string; steer: boolean; at: number; retryOf?: string; error?: string };
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

function deliver(run: Runner, id: string, message: Sent): Promise<void> {
  const args = ["send", id, message.text, "--cid", message.cid];
  if (message.retryOf) args.push("--retry-of", message.retryOf);
  return run(message.steer ? [...args, "--steer"] : args).then((reply) => {
    // Logged: the thread shows the turn and how it ended, so the message has its place there.
    if (reply.ok || reply.result === "logged") return;
    setSent(id, (list) => list.map((each) => (each.cid === message.cid ? { ...each, error: failure(reply) } : each)));
    sendFailed(message.cid);
  }, (cause) => {
    setSent(id, (list) => list.map((each) => each.cid === message.cid ? { ...each, error: String(cause) } : each));
    sendFailed(message.cid);
  });
}

/** The retry after a rewind uses the same pending bubble and command-id recovery as any send. */
export function retryMessage(run: Runner, id: string, text: string, retryOf: string): Promise<void> {
  const entry: Sent = { cid: newId(), text, steer: false, at: Date.now(), retryOf };
  setSent(id, (list) => [...list, entry]);
  return deliver(run, id, entry);
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
  // Dated as their rows will be (after the thread's last message, or the bubble before), so a row takes its place without a shift.
  let previous: { sentAt?: number } | undefined = session?.items.findLast((item) => item.kind === "message");
  return (
    // Under the footer's pt-4, the gaps a turn's row has (pt-6), so Rust's row takes a bubble's place without a shift.
    <div className="flex flex-col gap-6 pt-2">
      {shown.map((each) => {
        const dated = datedAfter(previous, each.at);
        previous = { sentAt: each.at };
        return (
          <UserBubble
            key={each.cid}
            keep={each.cid}
            text={each.text}
            time={each.at}
            dated={dated}
            failed={each.error}
            onRetry={() => {
              const again = { ...each, error: undefined };
              setSent(id, (now) => now.map((one) => (one.cid === each.cid ? again : one)));
              deliver(run, id, again);
            }}
            onDiscard={() => setSent(id, (now) => now.filter((one) => one.cid !== each.cid))}
          />
        );
      })}
    </div>
  );
}

/** The composer being left had the keyboard: the session opened in its place takes it. */
let hadKeyboard = false;

/** One queue action, shown at once until its reply is in and Rust's row has caught up with it (`touched`). */
type Op = { key: string; kind: "add" | "remove" | "resume" | "move"; qid: string; text?: string; slot?: number; at?: number; done?: () => void };

/**
 * The composer under a session's thread [D183, D188]: ⏎ sends, or while a turn runs queues (the fixed default until
 * wave 3, D191); ⌘⏎ or ⌥⏎ does the other, steering only where the agent can; ⌘⏎ in an empty field steers the first
 * queued message. Rust keeps the queue and sends it in order; Stop (■, Esc Esc) pauses it until Resume [D159].
 */
export function SessionComposer({ id, row, offline, blocked, onSent, run = daemonRun, source = answeringSource }: { id: string; row: ComposerRow | undefined; offline: boolean; /** Why sending waits (a start Rust hasn't made yet); the field stays usable. */ blocked?: string; onSent?: (id: string) => void; run?: Runner; source?: Source }) {
  const held = offline ? "Reconnecting…" : blocked;
  const field = useRef<ComposerFieldHandle>(null);
  // An approval takes the composer's place [D199, D317].
  const approval = useApprovalWaiting(id, source);
  const [initial] = useState(() => draftOf(id));
  const [empty, setEmpty] = useState(() => isEmpty({ parts: initial ?? [], attachmentIds: [] }));
  const [ops, setOps] = useState<Op[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  // A queued message pulled back to edit, which Rust keeps meanwhile (`queue.editing`): sending puts it back in its
  // slot under its id, emptying the field puts the original back.
  const editing = useRef<{ qid: string; slot: number; text: string } | null>(null);
  // A send into the paused queue, asked about first; its words stay in the field meanwhile.
  const [asking, setAsking] = useState<string | null>(null);
  // What waits above the field for the agent, and the chips the message being asked about carries [D1040].
  const chips = useChips(id);
  const askingChips = useRef<readonly Chip[]>([]);
  useLayoutEffect(() => () => void (hadKeyboard = document.activeElement?.closest("[data-slot=composer-field]") != null), []);
  useEffect(() => {
    if (hadKeyboard) field.current?.focus();
    hadKeyboard = false;
  }, []);
  const kept = row?.queue?.editing;
  // Reopened (or after a restart), the message being edited is in the field again: as last typed if its draft came back.
  useEffect(() => {
    const now = field.current;
    if (!kept || editing.current?.qid === kept.id || !now) return;
    editing.current = { qid: kept.id, slot: kept.slot, text: kept.text };
    if (!isEmpty({ parts: now.parts(), attachmentIds: [] })) return;
    now.set([kept.text]);
    setEmpty(!kept.text.trim());
  }, [kept?.id]);
  // After a restart the draft is Rust's alone: it comes back unless something was typed first.
  useEffect(() => {
    void loadDraft(run, id).then((saved) => {
      const now = field.current;
      if (!saved || !now) return;
      const parts = now.parts();
      if (!isEmpty({ parts, attachmentIds: [] }) && plainText(parts) !== editing.current?.text) return;
      now.set(saved);
      setEmpty(false);
    });
  }, []);

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

  const act = (op: Omit<Op, "key">, args: string[], fail?: (reply: Record<string, any>) => void) => {
    const key = newId();
    setOps((now) => [...now, { ...op, key }]);
    setError(null);
    void run(["queue", id, ...args]).then((reply) => {
      if (reply.ok) return setOps((now) => now.map((each) => (each.key === key ? { ...each, at: reply.at ?? 0 } : each)));
      setOps((now) => now.filter((each) => each.key !== key));
      setError(failure(reply));
      fail?.(reply);
    });
  };
  const queue = (message: string, qid = newId(), slot?: number, fail?: (reply: Record<string, any>) => void) =>
    act({ kind: "add", qid, text: message, slot }, slot === undefined ? ["add", message, "--qid", qid] : ["add", message, "--qid", qid, "--at", String(slot)], fail);
  /** The chips a message carries leave with it, and come back if Rust refused to queue it; a lost connection may have
   * queued it, so they stay in its message rather than go twice. */
  const carry = (sent: readonly Chip[], msg: string) => {
    leaveChips(id, sent);
    return (reply: Record<string, any>) => reply.error !== "disconnected" && restoreChips(id, msg, sent);
  };
  /** Rust takes the chips for message `msg` first, then it goes; refused, nothing goes and the field keeps it [D1174,
   * D1195]. `into`: the session it starts. */
  const going = (sent: readonly Chip[], msg: string, go: (back: (reply: Record<string, any>) => void) => void, into?: string) =>
    handOff(id, sent, msg, () => go(carry(sent, msg)), (reply) => setError(failure(reply)), into);
  const now = (message: string, steer = false, cid = newId()) => {
    const entry: Sent = { cid, text: message, steer, at: Date.now() };
    onSent?.(entry.cid);
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

  // Send as new, from a project session only: ⌥⌘⏎, ⌘-click on Send, or the /new chip in the text [D183, D204].
  const inProject = Boolean(row?.project);
  /** Empties the field for a message that's going, and answers the queued message it was edited from. */
  const take = () => {
    const pulled = editing.current;
    editing.current = null;
    field.current?.set([]);
    setEmpty(true);
    return pulled;
  };
  const isNew = (part: Draft["parts"][number]) => typeof part !== "string" && part.kind === "command" && part.id === NEW_SESSION.id;
  const submitNew = () => {
    const rest = (field.current?.parts() ?? []).filter((part) => !isNew(part));
    if (held || (isEmpty({ parts: rest, attachmentIds: [] }) && chips.length === 0)) return;
    const text = withChips(plainText(rest), chips);
    const made = { id: sessionId(), cid: newId() };
    going(chips, made.cid, () => sendAsNew(id, text, take()?.qid, made), made.id);
  };
  usePutBack(id, (message, above) => {
    // A rewound message goes above what's already being typed, never over it [D363].
    const typed = above ? (field.current?.parts() ?? []) : [];
    field.current?.set(isEmpty({ parts: typed, attachmentIds: [] }) ? [message] : [`${message}\n\n`, ...typed]);
    setEmpty(!message.trim());
    field.current?.focus();
  });

  const submit = (other: boolean) => {
    const parts = field.current?.parts() ?? [];
    if (held) return;
    if (inProject && parts.some(isNew)) return submitNew();
    if (isEmpty({ parts, attachmentIds: [] }) && chips.length === 0) {
      // ⌘⏎ with nothing typed steers the first queued message [D183].
      if (other && running && canSteer && items[0]?.state === "queued") steerQueued(items[0].id);
      return;
    }
    // The chips go after the words, and leave once it's sent or queued; a failed send keeps them in its message.
    const message = withChips(plainText(parts), chips);
    const mode = sendMode(running, "queue", other, canSteer);
    if (mode === "now" && paused && items.length > 0) {
      askingChips.current = chips;
      return setAsking(message);
    }
    const msg = (mode === "queue" && editing.current?.qid) || newId();
    going(chips, msg, (back) => {
      const pulled = take();
      if (mode === "queue") return queue(message, msg, pulled?.slot, back);
      sendNow(message, pulled, mode === "steer", msg);
    });
  };
  // Sent at once or steered, an edited message's kept copy goes.
  const sendNow = (message: string, pulled: typeof editing.current, steer = false, cid?: string) => {
    now(message, steer, cid);
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
        <SessionNotices id={id} offline={offline} source={source} run={run} />
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
        <SessionQuestions id={id} run={run} source={source} />
      </ComposerRail>
      <SessionApprovals id={id} run={run} source={source} />
      {/* Kept while an approval has its place, so the draft and its caret stay. */}
      <ComposerCard className={approval ? "hidden" : undefined}>
        {chips.length > 0 && (
          <div data-slot="composer-attachments" className="flex w-full flex-wrap items-end gap-2 px-1 pt-1 pb-1.5">
            {chips.map((chip) => (
              <CommentChip key={chip.id} comment={chip.comment} onRemove={() => dropChips(id, [chip.id])} />
            ))}
          </div>
        )}
        <ComposerField
          ref={field}
          initial={initial && { parts: initial, attachmentIds: [] }}
          placeholder="Do anything"
          onChange={(parts) => {
            keepDraft(run, id, parts);
            changed(isEmpty({ parts, attachmentIds: [] }));
          }}
          onSubmit={submit}
          onSubmitNew={inProject ? submitNew : undefined}
          commands={inProject ? { commands: [NEW_SESSION], onRun: () => {} } : undefined}
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
          <SendButton empty={empty && chips.length === 0} running={running} canStop={running && !offline} blocked={held} onSend={() => submit(false)} onSendNew={inProject ? submitNew : undefined} onStop={stop} />
        </ComposerFooter>
      </ComposerCard>
      <PausedSendDialog
        waiting={asking === null ? null : items.length}
        onSendNow={() => {
          if (asking !== null) {
            const [text, msg] = [asking, newId()];
            going(askingChips.current, msg, () => sendNow(text, take(), false, msg));
          }
          setAsking(null);
        }}
        onKeepPaused={() => {
          if (asking !== null) {
            const [text, msg] = [asking, editing.current?.qid ?? newId()];
            going(askingChips.current, msg, (back) => {
              const pulled = take();
              queue(text, msg, pulled?.slot, back);
            });
          }
          setAsking(null);
        }}
        onClose={() => {
          if (asking === null) return;
          setAsking(null);
          field.current?.focus();
        }}
      />
    </Composer>
  );
}
