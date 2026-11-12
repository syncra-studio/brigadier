import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { SharedComposer } from "../components/composer/composer";
import { type Draft, isEmpty, plainText, sendMode } from "../components/composer/draft";
import { ComposerField, type ComposerFieldHandle } from "../components/composer/field";
import { QueueCard, type QueuedMessage } from "../components/composer/queue";
import { PausedSendDialog } from "../components/composer/rail";
import { openWorker, SessionWorkersStrip, useWorkers } from "../workers/live";
import { ToWorkerChip } from "../workers/to-chip";
import { SendButton } from "../components/composer/send-button";
import { useSettings } from "../settings/api";
import { ErrorLine } from "../components/error-line";
import { ThinkingLine, UserBubble, datedAfter } from "../components/thread/message";
import { ask, type Row, threadSource, useDaemon } from "../daemon";
import { sessionId } from "../home/start";
import { type Chip, dropChips, handOff, leaveChips, restoreChips, useChips, withChips } from "../panel/chips";
import { AgentChipTile } from "../landing/agent-chip";
import { CommentChip } from "../review/comments";
import type { Source } from "../thread/thread";
import { sendFailed } from "../thread/follow";
import { answeringSource, SessionApprovals, SessionQuestions, useApprovalWaiting } from "./decisions";
import { SessionLevel } from "./level";
import { SessionModel, takesImages } from "./model";
import { SessionNotices } from "./notices";
import { draftOf, keepDraft, loadDraft } from "./draft";
import { useComposerCommands } from "./commands";
import { payload, useComposerFiles } from "./files";
import { NEW_SESSION, sendAsNew, usePutBack } from "./side";
import { newId } from "./store";
import { queuedOf, type RustQueued, toArgs } from "./queued";
import { useTurn } from "./turn";

/** A session's row with what the composer needs from Rust: its queue, whether its agent can steer, whether a turn is open. */
export type ComposerRow = Row & {
  /** `error`: why Rust couldn't send it; the queue waits on it. `editing`: the message pulled back to edit, kept by Rust. */
  queue?: { paused: boolean; items: RustQueued[]; editing?: { id: string; text: string; parts?: Draft; slot: number; to?: string } | null } | null;
  steer?: boolean;
  running?: boolean;
  model?: string | null;
  /** The last turn was the user's Stop: Resume carries it on, from Send or the queue [D373]. */
  resumable?: boolean;
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
type Sent = { cid: string; text: string; parts?: string; steer: boolean; at: number; retryOf?: string; error?: string };
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
  if (message.parts) args.push("--parts", message.parts);
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
export function retryMessage(run: Runner, id: string, text: string, retryOf: string, draft?: Draft | null): Promise<void> {
  const entry: Sent = { cid: newId(), text, parts: draft ? JSON.stringify(draft) : undefined, steer: false, at: Date.now(), retryOf };
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
            owner={id}
            parts={each.parts ? (JSON.parse(each.parts) as Draft).parts : undefined}
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
      {!shown.at(-1)!.error && <ThinkingLine />}
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
  const [empty, setEmpty] = useState(() => isEmpty({ parts: initial?.parts ?? [], attachmentIds: [] }));
  // What the field last reported, for drawing: reading the field mid-draw flushes its update into the draw (React error 520).
  const typed = useRef(initial?.parts ?? []);
  const files = useComposerFiles({ owner: id, run, field, backend: row?.backend, project: null, images: takesImages(row?.backend, row?.model), onTiles: (tiles) => keepDraft(run, id, { parts: field.current?.parts() ?? [], attachmentIds: tiles }) });
  const [ops, setOps] = useState<Op[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  // A queued message pulled back to edit, which Rust keeps meanwhile (`queue.editing`): sending puts it back in its
  // slot under its id, emptying the field puts the original back.
  const editing = useRef<{ qid: string; slot: number; text: string; to?: string } | null>(null);
  // A send into the paused queue, asked about first; its words stay in the field meanwhile.
  const [asking, setAsking] = useState<string | null>(null);
  // What waits above the field for the agent, and the chips the message being asked about carries [D1040].
  const chips = useChips(id);
  const askingChips = useRef<readonly Chip[]>([]);
  // The To: the worker the next message goes to alone (@ › Message directly); leaving the session takes it away.
  const [to, setTo] = useState<string | null>(null);
  const [toSending, setToSending] = useState(false);
  const rows = useDaemon().rows ?? [];
  const toWorker = useWorkers(id).find((each) => each.id === to) ?? null;
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
    editing.current = { qid: kept.id, slot: kept.slot, text: kept.text, to: kept.to };
    if (!isEmpty({ parts: now.parts(), attachmentIds: [] })) return;
    if (kept.to) setTo(kept.to);
    now.set(kept.parts?.parts ?? [kept.text]);
    files.restore(kept.parts?.attachmentIds ?? []);
    setEmpty(!kept.text.trim());
  }, [kept?.id]);
  // After a restart the draft is Rust's alone: it comes back unless something was typed first.
  useEffect(() => {
    void loadDraft(run, id).then((saved) => {
      const now = field.current;
      if (!saved || !now) return;
      const parts = now.parts();
      if (!isEmpty({ parts, attachmentIds: [] }) && plainText(parts) !== editing.current?.text) return;
      now.set(saved.parts);
      files.restore(saved.attachmentIds);
      setEmpty(false);
    });
  }, []);
  const { running, busy, resumable } = useTurn(id, row, source, useSending(id));
  const canSteer = row?.steer === true;
  // Queue or Steer, Rust's setting [D188].
  const followUp = useSettings().value?.follow_up ?? "queue";
  const touched = row?.touched ?? 0;
  const live = ops.filter((op) => op.at === undefined || touched < op.at);
  useEffect(() => {
    if (live.length === ops.length) return;
    ops.filter((op) => !live.includes(op)).forEach((op) => op.done?.());
    setOps(live);
  });
  let items: QueuedMessage[] = queuedOf(row?.queue?.items ?? [], rows);
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
  const queue = (message: string, qid = newId(), slot?: number, fail?: (reply: Record<string, any>) => void, parts?: string) =>
    act({ kind: "add", qid, text: message, slot }, [...(slot === undefined ? ["add", message, "--qid", qid] : ["add", message, "--qid", qid, "--at", String(slot)]), ...(parts ? ["--parts", parts] : [])], fail);
  /** The chips a message carries leave with it, and come back if Rust refused to queue it; a lost connection may have
   * queued it, so they stay in its message rather than go twice. */
  const carry = (sent: readonly Chip[], msg: string) => {
    leaveChips(id, sent);
    return (reply: Record<string, any>) => reply.error !== "disconnected" && restoreChips(id, msg, sent);
  };
  /** The field and the chips leave at once; Rust takes the chips for message `msg`, then it goes. Refused, nothing goes
   * and both come back [D30, D1174, D1195]. `into`: the session it starts. */
  const going = (sent: readonly Chip[], msg: string, go: (pulled: typeof editing.current, back: (reply: Record<string, any>) => void) => void, into?: string) => {
    const parts = field.current?.parts() ?? [];
    const tiles = files.tileIds;
    const pulled = take();
    files.sent();
    const back = carry(sent, msg);
    handOff(id, sent, msg, () => go(pulled, back), (reply) => {
      restoreChips(id, msg, sent);
      files.restore(tiles);
      editing.current ??= pulled;
      // The refused words go back above anything typed meanwhile, never over it, as a put-back does [D363].
      const typed = field.current?.parts() ?? [];
      field.current?.set(isEmpty({ parts: typed, attachmentIds: [] }) ? parts : [...parts, "\n\n", ...typed]);
      setEmpty(isEmpty({ parts, attachmentIds: [] }) && isEmpty({ parts: typed, attachmentIds: [] }));
      setError(failure(reply));
    }, into);
  };
  const now = (message: string, steer = false, cid = newId(), parts?: string) => {
    const entry: Sent = { cid, text: message, parts, steer, at: Date.now() };
    onSent?.(entry.cid);
    setSent(id, (list) => [...list, entry]);
    deliver(run, id, entry);
  };
  const steerQueued = (qid: string) => act({ kind: "remove", qid }, ["steer", qid]);
  const edit = (qid: string) => {
    const slot = items.findIndex((each) => each.id === qid);
    const message = text(qid);
    const { parts: draft, to: worker } = row?.queue?.items.find((each) => each.id === qid) ?? {};
    editing.current = { qid, slot: Math.max(slot, 0), text: message, to: worker };
    // One for a worker comes back with its To, as the old app's [D3050].
    if (worker) setTo(worker);
    field.current?.set(draft?.parts ?? [message]);
    files.restore(draft?.attachmentIds ?? []);
    setEmpty(!message.trim());
    act({ kind: "remove", qid }, ["edit", qid], () => {
      editing.current = null;
      field.current?.set([]);
    });
  };

  // Send as new, from a project session only: ⌥⌘⏎, ⌘-click on Send, or the /new chip in the text [D183, D204].
  const inProject = Boolean(row?.project);
  const extras = useComposerCommands({ owner: id, run, field, extra: inProject ? [NEW_SESSION] : [], fresh: running, onFiles: (picked) => picked.forEach((file) => files.attach(crypto.randomUUID(), file, false)) });
  /** Empties the field for a message that's going, and answers the queued message it was edited from. */
  const take = () => {
    const pulled = editing.current;
    editing.current = null;
    field.current?.set([]);
    setEmpty(true);
    return pulled;
  };
  /** The draft for Rust, which builds the agent's words from its parts: the chips' words go after them, as in the text. */
  const body = (parts: Draft["parts"], tiles: readonly string[], sent: readonly Chip[]) =>
    payload(sent.length === 0 ? parts : [...parts, `${isEmpty({ parts, attachmentIds: [] }) ? "" : "\n\n"}${withChips("", sent)}`], tiles);
  const isNew = (part: Draft["parts"][number]) => typeof part !== "string" && part.kind === "command" && part.id === NEW_SESSION.id;
  const submitNew = () => {
    const rest = (field.current?.parts() ?? []).filter((part) => !isNew(part));
    const tiles = files.tiles();
    if (held || files.hold(rest) || (isEmpty({ parts: rest, attachmentIds: tiles }) && chips.length === 0)) return;
    const text = withChips(plainText(rest), chips);
    const made = { id: sessionId(), cid: newId() };
    const parts = body(rest, tiles, chips);
    going(chips, made.cid, (pulled) => sendAsNew(id, text, pulled?.qid, made, parts), made.id);
  };
  usePutBack(id, (message, above, draft) => {
    // A rewound message goes above what's already being typed, never over it [D363]; its files come back with it.
    const typed = above ? (field.current?.parts() ?? []) : [];
    const back = draft?.parts ?? [message];
    field.current?.set(isEmpty({ parts: typed, attachmentIds: [] }) ? back : [...back, "\n\n", ...typed]);
    if (draft) files.restore(draft.attachmentIds);
    setEmpty(isEmpty({ parts: back, attachmentIds: draft?.attachmentIds ?? [] }));
    field.current?.focus();
  });

  /** To the worker alone, as the user's own message: steered, into its turn; else Rust gives it now or holds it in this
   * session's queue, "To ‹name›", until that worker's turn is over; an edited one goes back to its slot. Taken, the To:
   * goes and the worker opens; refused, the message and its To: come back [D3006, D3013, D3050]. */
  const sendTo = (worker: string, parts: Draft["parts"], tiles: string[], other: boolean) => {
    if (toSending) return;
    const [cid, message, draft] = [newId(), plainText(parts), payload(parts, tiles)];
    const target = rows.find((each) => each.id === worker) as ComposerRow | undefined;
    const steer = sendMode(true, followUp, other, target?.steer === true) === "steer";
    const pulled = take();
    const back = pulled?.to === worker ? pulled : null;
    if (pulled && !back) act({ kind: "add", qid: pulled.qid, text: pulled.text, slot: pulled.slot }, ["restore"]);
    files.sent();
    setToSending(true);
    setError(null);
    void run(toArgs(id, worker, message, back && !steer ? back : { qid: cid }, steer, draft)).then((reply) => {
      setToSending(false);
      if (reply.ok || reply.result === "logged") {
        if (steer && back) act({ kind: "remove", qid: back.qid }, ["remove", back.qid]);
        setTo((now) => (now === worker ? null : now));
        return openWorker(id, worker);
      }
      const since = field.current?.parts() ?? [];
      field.current?.set(isEmpty({ parts: since, attachmentIds: [] }) ? parts : [...parts, "\n\n", ...since]);
      files.restore(tiles);
      setEmpty(false);
      editing.current ??= back;
      setTo(worker);
      setError(failure(reply));
    });
  };

  const submit = (other: boolean) => {
    const parts = field.current?.parts() ?? [];
    if (held || files.hold(parts)) return;
    if (to && !isEmpty({ parts, attachmentIds: files.tiles() })) return sendTo(to, parts, files.tiles(), other);
    if (inProject && parts.some(isNew)) return submitNew();
    const tiles = files.tiles();
    if (isEmpty({ parts, attachmentIds: tiles }) && chips.length === 0) {
      // ⌘⏎ with nothing typed steers the first queued message [D183].
      if (other && running && canSteer && items[0]?.state === "queued") steerQueued(items[0].id);
      return;
    }
    // The chips go after the words, and leave once it's sent or queued; a failed send keeps them in its message.
    const message = withChips(plainText(parts), chips);
    const mode = sendMode(running, followUp, other, canSteer);
    if (mode === "now" && paused && items.length > 0) {
      askingChips.current = chips;
      return setAsking(message);
    }
    const msg = (mode === "queue" && editing.current?.qid) || newId();
    const draft = body(parts, tiles, chips);
    going(chips, msg, (pulled, back) => (mode === "queue" ? queue(message, msg, pulled?.slot, back, draft) : sendNow(message, pulled, mode === "steer", msg, draft)));
  };
  // Sent at once or steered, an edited message's kept copy goes.
  const sendNow = (message: string, pulled: typeof editing.current, steer = false, cid?: string, parts?: string) => {
    now(message, steer, cid, parts);
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
  const resuming = live.some((op) => op.kind === "resume");
  const move = (qid: string, to: number) =>
    new Promise<void>((resolve, reject) => act({ kind: "move", qid, done: resolve }, ["move", qid, String(to)], reject));

  return (
    <SharedComposer
      rail={
        <>
          <SessionWorkersStrip id={id} />
          <SessionNotices id={id} offline={offline} source={source} run={run} />
          <QueueCard
            items={items}
            paused={paused}
            resuming={resuming || offline}
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
        </>
      }
      above={<SessionApprovals id={id} run={run} source={source} />}
      // Kept while an approval has its place, so the draft and its caret stay.
      hidden={Boolean(approval)}
      onDragOver={files.onDragOver}
      onDrop={files.onDrop}
      tiles={
        <>
          {files.tilesRow}
          {chips.length > 0 && (
            <div data-slot="composer-attachments" className="flex w-full flex-wrap items-end gap-2 px-1 pt-1 pb-1.5">
              {chips.map((chip) =>
                chip.kind === "agent" ? (
                  <AgentChipTile key={chip.id} chip={chip.chip} onRemove={() => dropChips(id, [chip.id])} />
                ) : (
                  <CommentChip key={chip.id} comment={chip.comment} onRemove={() => dropChips(id, [chip.id])} />
                ),
              )}
            </div>
          )}
        </>
      }
      plus={extras.plus}
      level={
        <>
          <SessionLevel id={id} row={row} />
          {toWorker && <ToWorkerChip worker={toWorker} sending={toSending} onClear={() => setTo(null)} />}
        </>
      }
      // With nothing queued the queue card isn't there to say why a Resume was refused.
      status={<ErrorLine error={stopError ?? (items.length === 0 ? error : null)} className="min-w-0 truncate" />}
      model={<SessionModel id={id} row={row} offline={offline} />}
      send={<SendButton followUp={followUp} empty={empty && chips.length === 0 && files.tileIds.length === 0} running={busy} canStop={busy && !offline} canResume={resumable} to={toWorker?.name} blocked={held ?? files.hold(typed.current) ?? (toSending ? `Send to ${toWorker?.name ?? "the worker"}` : undefined)} onSend={() => submit(false)} onSendNew={inProject && !toWorker ? submitNew : undefined} onStop={stop} onResume={resuming ? undefined : resume} />}
      after={
        <PausedSendDialog
          waiting={asking === null ? null : items.length}
          onSendNow={() => {
            if (asking !== null) {
              const [text, msg, draft] = [asking, newId(), body(field.current?.parts() ?? [], files.tiles(), askingChips.current)];
              going(askingChips.current, msg, (pulled) => sendNow(text, pulled, false, msg, draft));
            }
            setAsking(null);
          }}
          onKeepPaused={() => {
            if (asking !== null) {
              const [text, msg, draft] = [asking, editing.current?.qid ?? newId(), body(field.current?.parts() ?? [], files.tiles(), askingChips.current)];
              going(askingChips.current, msg, (pulled, back) => queue(text, msg, pulled?.slot, back, draft));
            }
            setAsking(null);
          }}
          onClose={() => {
            if (asking === null) return;
            setAsking(null);
            field.current?.focus();
          }}
        />
      }
    >
      <ComposerField
        ref={field}
        initial={initial}
        placeholder={toWorker ? `Message ${toWorker.name}` : "Do anything"}
        attachments={files.attachments}
        onAttach={files.attach}
        mentions={{ ...files.mentions, onDirect: setTo }}
        onChange={(parts) => {
          typed.current = parts;
          keepDraft(run, id, { parts, attachmentIds: files.tileIds });
          changed(isEmpty({ parts, attachmentIds: [] }));
        }}
        onSubmit={submit}
        onSubmitNew={inProject ? submitNew : undefined}
        commands={extras.commands}
        onOpen={extras.onOpen}
        onPullQueued={() => {
          // None is pulled into a composer whose next message goes to a worker.
          if (toWorker) return false;
          const last = items.findLast((each) => each.state === "queued");
          if (!last) return false;
          edit(last.id);
          return true;
        }}
      />
    </SharedComposer>
  );
}
