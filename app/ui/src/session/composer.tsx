import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { SharedComposer } from "../components/composer/composer";
import { type Draft, isEmpty, plainText, sendMode, swapWords } from "../components/composer/draft";
import { asShell, asWords, commandOf, isShell } from "../components/composer/shell";
import { ComposerField, type ComposerFieldHandle } from "../components/composer/field";
import { QueueCard, type QueuedMessage } from "../components/composer/queue";
import { PausedSendDialog } from "../components/composer/rail";
import { openWorker, SessionWorkersStrip, useWorkers } from "../workers/live";
import { ToWorkerChip } from "../workers/to-chip";
import { SendButton } from "../components/composer/send-button";
import { useSettings } from "../settings/api";
import { ErrorLine } from "../components/error-line";
import { ask, type Row, showStop, threadSource, useDaemon } from "../daemon";
import { sessionId } from "../home/start";
import { type Chip, dropChips, handOff, leaveChips, restoreChips, useChips, withChips } from "../panel/chips";
import { AgentChipTile } from "../landing/agent-chip";
import { CommentChip } from "../review/comments";
import { sendFailed } from "../thread/follow";
import type { Source } from "../thread/thread";
import { answeringSource, SessionApprovals, SessionQuestions, useApprovalWaiting } from "./decisions";
import { SessionLevel } from "./level";
import { takesImages, useSessionModel } from "./model";
import { SessionNotices } from "./notices";
import { draftOf, givenError, keepDraft, loadDraft, onGiven, revOf, takeBack } from "./draft";
import { useComposerCommands } from "./commands";
import { payload, useComposerFiles } from "./files";
import { NEW_SESSION, sendAsNew, usePutBack } from "./side";
import { newId } from "./store";
import { inThread, queuedOf, type RustQueued, toArgs } from "./queued";
import { deliver, draftArgs, type Sent, setSent, useOnItsWay } from "./sent";
import { addUncertain, dropUncertain, useUncertain } from "./uncertain";
import { useTurn } from "./turn";
import { OVERNIGHT, overnight, useOvernight } from "../sessions/overnight";
import { NightReady, nightLook, nightPlaceholder, OvernightStrip, SessionOvernight, StartNight } from "../sessions/overnight-parts";

/** A session's row with what the composer needs from Rust: its queue, whether its agent can steer, whether a turn is open. */
export type ComposerRow = Row & {
  /** `error`: why Rust couldn't send it; the queue waits on it. `editing`: the message pulled back to edit, kept by Rust. */
  queue?: { paused: boolean; items: RustQueued[]; editing?: { id: string; text: string; parts?: Draft; slot: number; to?: string; shell?: string } | null; /** The `!` commands what waits here goes after. */ running?: string[] } | null;
  steer?: boolean;
  running?: boolean;
  model?: string | null;
  /** The last turn was the user's Stop: Resume carries it on, from Send or the queue [D373]. */
  resumable?: boolean;
  /** A rebirth under way: its turn being stopped, or its fresh conversation not yet started [D88, D112]. */ optimizing?: boolean;
};

/** Runs a brigadier command and answers its whole reply, a refusal included. */
export type Runner = (args: string[]) => Promise<Record<string, any>>;
export const daemonRun: Runner = (args) => new Promise((resolve) => ask({ op: "run", args }, resolve));

export const failure = (reply: Record<string, any>) => (reply.error === "disconnected" ? "Brigadier isn't running" : String(reply.message ?? reply.error ?? "Refused"));

/** Nothing to send: a command with no words too. */
const blank = (parts: Draft["parts"]) => isEmpty({ parts: isShell(parts) ? [plainText(parts).slice(1)] : parts, attachmentIds: [] });

/** The composer being left had the keyboard: the session opened in its place takes it. */
let hadKeyboard = false;

/** One queue action, shown at once until its reply is in and Rust's row has caught up with it (`touched`). */
/** The field's draft a message was sent from, its revision then, and its chips: what Rust gives back if it's refused. */
type Sub = { draft: Draft; rev: number | null; chips: readonly Chip[] };

type Op = { key: string; kind: "add" | "command" | "remove" | "resume" | "move"; qid: string; text?: string; slot?: number; shell?: boolean; at?: number; done?: () => void };

/**
 * The composer under a session's thread [D183, D188]: ⏎ sends, or while a turn runs queues (the fixed default until
 * wave 3, D191); ⌘⏎ or ⌥⏎ does the other, steering only where the agent can; ⌘⏎ in an empty field steers the first
 * queued message. Rust keeps the queue and sends it in order; Stop (■, Esc Esc) pauses it until Resume [D159]. `!`
 * first makes it a command, which waits its turn in the queue and runs at once between turns [D316].
 */
export function SessionComposer({ id, row, offline, blocked, onSent, run = daemonRun, source = answeringSource, placeholder = "Do anything", worker = false }: { id: string; row: ComposerRow | undefined; offline: boolean; /** Why sending waits (a start Rust hasn't made yet); the field stays usable. */ blocked?: string; onSent?: (id: string) => void; run?: Runner; source?: Source; placeholder?: string; /** A worker's own tab: its model shown but fixed, no permission picker, no Stop or Resume, no new session [D293]. */ worker?: boolean }) {
  const held = offline ? "Reconnecting…" : blocked;
  const field = useRef<ComposerFieldHandle>(null);
  const model = useSessionModel(id, row, offline, worker);
  // An approval takes the composer's place [D199, D317].
  const approval = useApprovalWaiting(id, source);
  const [initial] = useState(() => draftOf(id));
  const [empty, setEmpty] = useState(() => blank(initial?.parts ?? []));
  const [shell, setShell] = useState(() => !worker && isShell(initial?.parts ?? []));
  // What the field last reported, for drawing: reading the field mid-draw flushes its update into the draw (React error 520).
  const typed = useRef(initial?.parts ?? []);
  const files = useComposerFiles({ owner: id, run, field, backend: row?.backend, project: null, images: takesImages(row?.backend, row?.model), onTiles: (tiles) => keepDraft(run, id, { parts: field.current?.parts() ?? [], attachmentIds: tiles }) });
  const [ops, setOps] = useState<Op[]>([]);
  const [error, setError] = useState<string | null>(() => givenError(id));
  const [stopError, setStopError] = useState<string | null>(null);
  // A queued message pulled back to edit, which Rust keeps meanwhile (`queue.editing`): sending puts it back in its slot under its id, emptying the field puts the original back.
  const editing = useRef<{ qid: string; slot: number; text: string; to?: string; shell?: boolean } | null>(null);
  // A send into the paused queue, asked about first; its words stay in the field meanwhile.
  const [asking, setAsking] = useState<string | null>(null);
  // What waits above the field for the agent, and the chips the message being asked about carries [D1040].
  const chips = useChips(id);
  const askingChips = useRef<readonly Chip[]>([]);
  // The To: the worker the next message goes to alone (@ › Message directly); leaving the session takes it away.
  const [to, setTo] = useState<string | null>(null);
  const [toSending, setToSending] = useState(false);
  const { daemon, rows: shown } = useDaemon();
  const rows = shown ?? [];
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
    editing.current = { qid: kept.id, slot: kept.slot, text: kept.text, to: kept.to, shell: kept.shell !== undefined };
    if (!isEmpty({ parts: now.parts(), attachmentIds: [] })) return;
    if (kept.to) setTo(kept.to);
    now.set(kept.shell ? asShell([kept.text]) : (kept.parts?.parts ?? asWords([kept.text])));
    files.restore(kept.parts?.attachmentIds ?? []);
    setEmpty(!kept.text.trim());
  }, [kept?.id]);
  // After a restart the draft is Rust's alone: it comes back unless something was typed first. One given back while
  // the session was closed brings its tiles.
  useEffect(() => {
    if (initial?.attachmentIds.some((tile) => !files.tileIds.includes(tile))) files.restore(initial.attachmentIds);
    void loadDraft(run, id).then((saved) => {
      const now = field.current;
      if (!saved || !now) return;
      const parts = now.parts();
      if (!isEmpty({ parts, attachmentIds: [] }) && plainText(parts).replace(/^!/, editing.current?.shell ? "" : "!") !== editing.current?.text) return;
      now.set(saved.parts);
      files.restore(saved.attachmentIds);
      setEmpty(false);
    });
  }, []);
  const { running, busy, resumable, stopping } = useTurn(id, row, source, useOnItsWay(id));
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
  const night = useOvernight(id, worker ? undefined : row);
  // Its turn's last questions are in the thread already, waiting or answered.
  const asked = useSyncExternalStore(source.subscribe, () => {
    const thread = night?.state === "asking" ? source.get() : null;
    const turn = thread?.id === id ? thread.turns.at(-1)?.id : undefined;
    return turn !== undefined && thread!.items.some((item) => item.kind === "question" && item.turnId === turn);
  });
  const delivered = inThread(useSyncExternalStore(source.subscribe, source.get)); // It leaves the queue as the thread shows it.
  const uncertain = useUncertain(id, row ? (row.queue ?? null) : undefined, delivered, daemon, (qid) => act({ kind: "remove", qid }, ["remove", qid]));
  let paused = row?.queue?.paused === true;
  // A `!` command that ended shows only while its report can't go.
  const queued = (row?.queue?.items ?? []).filter((each) => (each.shell === "ended" ? paused || each.error : !delivered.has(each.id)));
  let items: QueuedMessage[] = queuedOf(queued, rows);
  for (const op of live) {
    if (op.kind === "remove") items = items.filter((each) => each.id !== op.qid);
    if (op.kind === "resume") paused = false;
    if (op.kind === "add" && !delivered.has(op.qid) && !items.some((each) => each.id === op.qid)) {
      items = items.toSpliced(op.slot ?? items.length, 0, { id: op.qid, draft: { parts: [op.text ?? ""], attachmentIds: [] }, state: "local", shell: op.shell });
    }
  }
  items = [...items, ...uncertain.rows.filter((each) => !delivered.has(each.id) && !items.some((one) => one.id === each.id))];
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
  /** With `sub`, a refusal gives it back (`carry`), and one whose reply never came waits marked in the queue (uncertain.ts). */
  const queue = (message: string, qid = newId(), slot?: number, fail?: (reply: Record<string, any>) => void, parts?: string, sub?: Sub) =>
    act({ kind: "add", qid, text: message, slot }, [...(slot === undefined ? ["add", message, "--qid", qid] : ["add", message, "--qid", qid, "--at", String(slot)]), ...(parts ? ["--parts", parts] : []), ...draftArgs(sub?.draft, sub?.rev ?? null)], (reply) => {
      if (sub && reply.error === "disconnected") addUncertain(id, { qid, text: message, draft: sub.draft, parts, at: Date.now() }, daemon);
      fail?.(reply);
    });
  /** The chips a message carries leave with it. Refused, Rust gives the message back with them (an edited one's kept
   * copy goes: it comes back as a new draft); a lost connection may have queued it, so they stay in its message rather
   * than go twice. */
  const carry = (sent: readonly Chip[], msg: string, pulled: typeof editing.current = null, sub?: Sub) => {
    leaveChips(id, sent);
    return (reply: Record<string, any>) => {
      if (reply.error === "disconnected") return;
      if (!reply.given_back || !sub) return restoreChips(id, msg, sent);
      if (!reply.again) takeBack(run, id, { cid: msg, ...sub.draft, chips: sent, error: failure(reply) });
      if (pulled) act({ kind: "remove", qid: pulled.qid }, ["remove", pulled.qid]);
    };
  };
  /** The field and the chips leave at once; Rust takes the chips for message `msg`, then it goes. Refused, nothing goes
   * and both come back [D30, D1174, D1195]. `into`: the session it starts. */
  const going = (sent: readonly Chip[], msg: string, go: (pulled: typeof editing.current, back: (reply: Record<string, any>) => void, sub: Sub) => void, into?: string) => {
    const sub: Sub = { draft: { parts: field.current?.parts() ?? [], attachmentIds: [...files.tileIds] }, rev: revOf(id), chips: sent };
    const pulled = take();
    files.sent(into ? [] : sub.draft.parts);
    const back = carry(sent, msg, pulled, sub);
    // Refused, its words, files and chips come back above what's typed since, Rust's give-back or not [D363].
    handOff(id, sent, msg, () => go(pulled, back, sub), (reply) => {
      editing.current ??= pulled;
      takeBack(run, id, { cid: msg, ...sub.draft, chips: sent, error: failure(reply) });
    }, into, into ? [] : draftArgs(sub.draft, sub.rev));
  };
  const now = (message: string, steer = false, cid = newId(), parts?: string, sub?: Sub) => {
    const entry: Sent = { cid, text: message, parts, steer, at: Date.now(), ...sub };
    onSent?.(entry.cid);
    setSent(id, (list) => [...list, entry]);
    deliver(run, id, entry);
  };
  const steerQueued = (qid: string) => act({ kind: "remove", qid }, ["steer", qid]);
  // What waits behind a command that runs goes after it, as behind a turn.
  const commands = (row?.queue?.running?.length ?? 0) > 0 || live.some((op) => op.kind === "command");
  /** A `!` command, through Rust's queue: at once between turns, else in its turn. Refused, its words come back, under what's typed since. */
  const runCommand = (line: string, parts: Draft["parts"]) => {
    const pulled = take();
    const qid = pulled?.qid ?? `c-${newId()}`;
    const at = pulled ? ["--at", String(pulled.slot)] : [];
    const waits = running || commands || items.length > 0;
    act({ kind: waits ? "add" : "command", qid, text: line, slot: pulled?.slot, shell: true }, ["add", line, "--qid", qid, "--shell", ...at], () => {
      sendFailed(qid);
      const since = field.current?.parts() ?? [];
      field.current?.set(blank(since) ? parts : [...since, "\n\n", ...parts]);
      editing.current ??= pulled;
    });
    if (!waits) onSent?.(qid);
  };
  const edit = (qid: string) => {
    // One not added goes above what's typed, as a message given back [D363].
    const lost = uncertain.find(qid);
    if (lost) return takeBack(run, id, { cid: qid, ...lost.draft });
    const slot = items.findIndex((each) => each.id === qid);
    const message = text(qid);
    const { parts: draft, to: worker, shell: command } = row?.queue?.items.find((each) => each.id === qid) ?? {};
    editing.current = { qid, slot: Math.max(slot, 0), text: message, to: worker, shell: command !== undefined };
    // One for a worker comes back with its To, as the old app's [D3050].
    if (worker) setTo(worker);
    field.current?.set(command ? asShell([message]) : (draft?.parts ?? asWords([message])));
    files.restore(draft?.attachmentIds ?? []);
    setEmpty(!message.trim());
    act({ kind: "remove", qid }, ["edit", qid], () => {
      editing.current = null;
      field.current?.set([]);
    });
  };

  // Send as new, from a project session only: ⌥⌘⏎, ⌘-click on Send, or the /new chip in the text [D183, D204].
  const inProject = Boolean(row?.project) && !worker;
  const extras = useComposerCommands({ owner: id, run, field, extra: worker ? [] : [...(inProject ? [NEW_SESSION] : []), { ...OVERNIGHT, run: () => overnight(id, night ? "off" : "on") }], fresh: running, onFiles: (picked) => picked.forEach((file) => files.attach(crypto.randomUUID(), file, false)) });
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
  // A message Rust gave back goes above what's typed since, never over it, with its files [D363].
  useEffect(() =>
    onGiven(id, (back) => {
      const typed = field.current?.parts() ?? [];
      const parts = isEmpty({ parts: typed, attachmentIds: [] }) ? back.parts : [...back.parts, "\n\n", ...typed];
      field.current?.set(parts);
      files.restore(back.attachmentIds);
      setEmpty(isEmpty({ parts, attachmentIds: back.attachmentIds }));
      if (back.error) setError(back.error);
      return { parts, attachmentIds: [...new Set([...back.attachmentIds, ...files.tileIds])] };
    }),
  );
  usePutBack(id, (message, above, draft, swap) => {
    const swapped = swap && swapWords(field.current?.parts() ?? [], swap.was, swap.now);
    if (swapped) {
      field.current?.set(asWords(swapped));
      setEmpty(isEmpty({ parts: swapped, attachmentIds: files.tiles() }));
      return field.current?.focus();
    }
    // A rewound message goes above what's already being typed, never over it [D363]; its files come back with it.
    const typed = above ? (field.current?.parts() ?? []) : [];
    const back = draft?.parts ?? asWords([message]);
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
    if (pulled && !back) act({ kind: "add", qid: pulled.qid, text: pulled.text, slot: pulled.slot, shell: pulled.shell }, ["restore"]);
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
    const command = to || worker ? null : commandOf(parts);
    if (command !== null) return runCommand(command, parts);
    if (!to && !worker && isShell(parts)) return; // a command with nothing to run
    if (to && !isEmpty({ parts, attachmentIds: files.tiles() })) return sendTo(to, parts, files.tiles(), other);
    if (inProject && parts.some(isNew)) return submitNew();
    const tiles = files.tiles();
    if (isEmpty({ parts, attachmentIds: tiles }) && chips.length === 0) {
      // ⌘⏎ with nothing typed steers the first queued message [D183].
      if (other && running && canSteer && items[0]?.state === "queued" && !items[0].shell) steerQueued(items[0].id);
      return;
    }
    // The chips go after the words, and leave once it's sent or queued; a failed send keeps them in its message.
    const message = withChips(plainText(parts), chips);
    const mode = worker && row?.worker?.kind === "paused" ? "queue" : sendMode(running || commands, followUp, other, canSteer && running); // Held till Resume [D3041].
    if (mode === "now" && paused && items.length > 0) {
      askingChips.current = chips;
      return setAsking(message);
    }
    const msg = (mode === "queue" && editing.current?.qid) || newId();
    const draft = body(parts, tiles, chips);
    going(chips, msg, (pulled, back, sub) => (mode === "queue" ? queue(message, msg, pulled?.slot, back, draft, sub) : sendNow(message, pulled, mode === "steer", msg, draft, sub)));
  };
  // Sent at once or steered, an edited message's kept copy goes.
  const sendNow = (message: string, pulled: typeof editing.current, steer = false, cid?: string, parts?: string, sub?: Sub) => {
    now(message, steer, cid, parts, sub);
    if (pulled) act({ kind: "remove", qid: pulled.qid }, ["remove", pulled.qid]);
  };
  const changed = (blank: boolean) => {
    setEmpty(blank);
    const pulled = editing.current;
    if (!blank || !pulled) return;
    editing.current = null;
    act({ kind: "add", qid: pulled.qid, text: pulled.text, slot: pulled.slot, shell: pulled.shell }, ["restore"]);
  };
  const stuck = row?.queue?.items.find((each) => each.error);
  const stop = () => {
    setStopError(null);
    const shown = showStop(id);
    void run(["stop", id]).then((reply) => (shown(reply.ok === true), !reply.ok && setStopError(failure(reply))));
  };
  const resume = () => act({ kind: "resume", qid: "" }, ["resume"]);
  const resuming = live.some((op) => op.kind === "resume");
  const move = (qid: string, to: number) => new Promise<void>((resolve, reject) => act({ kind: "move", qid, done: resolve }, ["move", qid, String(to)], reject));

  return (
    <SharedComposer
      rail={
        <>
          <SessionWorkersStrip id={id} />
          {!worker && <OvernightStrip id={id} now={night} />}
          {!worker && <NightReady id={id} now={night} />}
          <SessionNotices id={id} offline={offline} source={source} run={run} />
          <QueueCard
            items={items}
            paused={paused}
            resuming={resuming || stopping || offline}
            steer={canSteer && running}
            canEdit={empty}
            error={(stuck ? `Not sent: ${stuck.error}. ${stuck.to ? "Edit it, delete it or send it to the session instead." : "Edit or delete it to go on."}` : null) ?? error}
            onResume={resume}
            onSteer={steerQueued}
            onRemove={(qid) => (uncertain.find(qid) ? uncertain.drop(qid) : act({ kind: "remove", qid }, ["remove", qid]))}
            onEdit={edit}
            onAddAgain={(qid) => {
              const lost = uncertain.find(qid)!;
              const sub = { draft: lost.draft, rev: null, chips: [] };
              dropUncertain(id, qid);
              queue(lost.text, qid, undefined, carry([], qid, null, sub), lost.parts, sub);
            }}
            onToSession={(qid) => queue(text(qid), qid, undefined, undefined, JSON.stringify(row?.queue?.items.find((each) => each.id === qid)?.parts))}
            onMove={move}
          />
          <SessionQuestions id={id} run={run} source={source} backend={row?.backend} images={takesImages(row?.backend, row?.model)} night={night?.state === "asking" ? (round) => <StartNight id={id} label="Or start now: it picks what you skip and tells you in the morning" {...round} /> : undefined} />
        </>
      }
      above={<SessionApprovals id={id} run={run} source={source} />}
      // Kept while an approval has its place, so the draft and its caret stay.
      hidden={approval}
      shell={shell && !toWorker}
      look={nightLook(night !== null)}
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
          {!worker && <SessionLevel id={id} row={row} />}
          {!worker && <SessionOvernight id={id} now={night} />}
          {toWorker && <ToWorkerChip worker={toWorker} sending={toSending} onClear={() => setTo(null)} />}
        </>
      }
      // With nothing queued the queue card isn't there to say why a Resume was refused.
      status={row?.optimizing ? <span className="min-w-0 truncate text-xs text-muted-foreground shimmer">Optimizing context…</span> : <ErrorLine error={stopError ?? (items.length === 0 ? error : null)} className="min-w-0 truncate" />}
      model={model}
      send={<SendButton shell={shell && !toWorker} followUp={running ? followUp : "queue"} empty={empty && chips.length === 0 && files.tileIds.length === 0} running={busy || (commands && !empty)} canStop={busy && !offline && !worker} canResume={resumable && !worker} to={toWorker?.name} blocked={held ?? files.hold(typed.current) ?? (toSending ? `Send to ${toWorker?.name ?? "the worker"}` : undefined)} onSend={() => submit(false)} onSendNew={inProject && !toWorker ? submitNew : undefined} onStop={stop} onResume={resuming || stopping ? undefined : resume} />}
      after={
        <PausedSendDialog
          waiting={asking === null ? null : items.length}
          onSendNow={() => {
            if (asking !== null) {
              const [text, msg, draft] = [asking, newId(), body(field.current?.parts() ?? [], files.tiles(), askingChips.current)];
              going(askingChips.current, msg, (pulled, _, sub) => sendNow(text, pulled, false, msg, draft, sub));
            }
            setAsking(null);
          }}
          onKeepPaused={() => {
            if (asking !== null) {
              const [text, msg, draft] = [asking, editing.current?.qid ?? newId(), body(field.current?.parts() ?? [], files.tiles(), askingChips.current)];
              going(askingChips.current, msg, (pulled, back, sub) => queue(text, msg, pulled?.slot, back, draft, sub));
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
        placeholder={toWorker ? `Message ${toWorker.name}` : (nightPlaceholder(night, busy, asked) ?? placeholder)}
        attachments={files.attachments}
        onAttach={files.attach}
        mentions={{ ...files.mentions, onDirect: setTo }}
        onChange={(parts) => {
          typed.current = parts;
          keepDraft(run, id, { parts, attachmentIds: files.tileIds });
          setShell(!worker && isShell(parts));
          changed(blank(parts));
        }}
        onSubmit={submit} shell={!toWorker && !worker}
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
