// The composer's send and queue actions: Send, Queue and Steer, the queue's edits, a lost To:'s, /new, Stop and Resume.
import type { Dispatch, RefObject, SetStateAction } from "react";
import { Alert } from "react-native";
import type { Chip as PanelChip } from "../../../app/shared/chips";
import { type Draft, isEmpty, plainText, sendMode } from "../../../app/shared/draft";
import { type QueuedMessage, toArgs } from "../../../app/shared/session/queued";
import { failure } from "../../../app/shared/session/run";
import { chipArgs, draftArgs, sendOp } from "../../../app/shared/session/sent";
import type { Going } from "../../../app/shared/session/uncertain";
import type { Frame } from "../../../app/shared/client";
import { lists } from "../mac/mac";
import { type Power, refusal, shellOf, shellPower } from "../powers/powers";
import { NEW_SESSION } from "./Menus";
import { body, type ComposerRow, isNew, lostReply, type Named, type Op, partsOf, payload, type Pulled, sessionId, type Sub, type To, unsigned, unsure } from "./parts";
import { type forMac, newId, type ToLost, withChips } from "./state";

/** What the composer's actions read from its render, each render's own. */
type Scope = {
  id: string;
  mac: ReturnType<typeof forMac>;
  row: ComposerRow | undefined;
  connected: boolean;
  worker: boolean;
  to: To | null;
  toWorker: To | null;
  toSending: boolean;
  toGone: boolean;
  inProject: boolean;
  running: boolean;
  canSteer: boolean;
  commands: boolean;
  paused: boolean;
  items: QueuedMessage[];
  editing: { get: () => Pulled; set: (pulled: Pulled) => void };
  lost: (qid: string) => Going | undefined;
  textOf: (qid: string) => string;
  readyNow: () => string[];
  tilesNow: () => readonly string[];
  partsNow: () => Draft["parts"];
  setField: (parts: Draft["parts"], save?: boolean) => void;
  waitsFor: () => string | undefined;
  words$: RefObject<string>;
  named$: RefObject<Named[]>;
  setOps: Dispatch<SetStateAction<Op[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setPowerError: Dispatch<SetStateAction<string | null>>;
  setPower: Dispatch<SetStateAction<(Power & { then: (reply: Frame) => void }) | null>>;
  setToSending: Dispatch<SetStateAction<boolean>>;
  setTo: Dispatch<SetStateAction<To | null>>;
  setStopping: Dispatch<SetStateAction<boolean>>;
};

export function sendActions({ id, mac, row, connected, worker, to, toWorker, toSending, toGone, inProject, running, canSteer, commands, paused, items, editing, lost, textOf, readyNow, tilesNow, partsNow, setField, waitsFor, words$, named$, setOps, setError, setPowerError, setPower, setToSending, setTo, setStopping }: Scope) {
  const { run, drafts, sends: sending, chips: waitingChips, files: fileStore } = mac;
  const act = (op: Omit<Op, "key">, args: string[], fail?: (reply: Record<string, any>) => void, then?: (reply: Record<string, any>) => void) => {
    const key = newId();
    setOps((now) => [...now, { ...op, key }]);
    setError(null);
    void run(["queue", id, ...args]).then((reply) => {
      then?.(reply);
      if (reply.ok) return setOps((now) => now.map((each) => (each.key === key ? { ...each, at: reply.at ?? 0 } : each)));
      setOps((now) => now.filter((each) => each.key !== key));
      setError(failure(reply));
      fail?.(reply);
    });
  };
  /** With `sub`, the field's own message: kept first, it takes its chips as it goes, and Rust gives it back if it's refused. */
  const queue = (message: string, qid: string, slot: number | undefined, fail: ((reply: Record<string, any>) => void) | undefined, parts: string | undefined, sub: Sub) => {
    const args = ["add", message, "--qid", qid, ...(slot === undefined ? [] : ["--at", String(slot)]), ...(parts ? ["--parts", parts] : []), ...chipArgs(sub.chips)];
    const entry = sending.keep(id, { cid: qid, kind: "queue", op: ["queue", id, ...args], draft: sub.draft, rev: sub.rev, chips: sub.chips, at: Date.now() });
    act({ kind: "add", qid, text: message, slot }, [...args, ...draftArgs(sub.draft, sub.rev)], fail, (reply) => sending.answered(run, id, entry, reply));
  };
  /** Given back, an edited message's kept copy goes: its words come back as a new draft, never under the refused id. */
  const gave = (pulled: Pulled) => (reply: Record<string, any>) => reply.given_back && pulled && act({ kind: "remove", qid: pulled.qid }, ["remove", pulled.qid]);
  /** Empties the field for a message that's going, and answers the queued message it was edited from. */
  const take = () => {
    const pulled = editing.get();
    editing.set(null);
    setField([]);
    return pulled;
  };
  /** The field and the chips leave at once, the message kept first, so nothing is lost [D30, D363]. */
  const goes = (parts: Draft["parts"], sent: readonly PanelChip[], send: (pulled: Pulled, sub: Sub) => void) => {
    const sub: Sub = { draft: { parts, attachmentIds: readyNow() }, rev: drafts.revOf(id), chips: sent };
    send(editing.get(), sub);
    fileStore.sent(id);
    take();
    waitingChips.leave(id, sent);
  };
  // Sent at once or steered, an edited message's kept copy goes.
  const sendNow = (message: string, pulled: Pulled, steer: boolean, cid: string, parts: string | undefined, sub: Sub) => {
    void sending.go(run, id, { cid, kind: "send", op: sendOp(id, message, cid, { parts, steer, chips: sub.chips }), draft: sub.draft, chips: sub.chips, at: Date.now() }, sub.rev);
    if (pulled) act({ kind: "remove", qid: pulled.qid }, ["remove", pulled.qid]);
  };
  const steerQueued = (qid: string) => act({ kind: "remove", qid }, ["steer", qid]);
  const edit = (qid: string) => {
    // One Rust may not hold goes from there, its words above what's typed, as a new message [D363].
    const mine = lost(qid);
    if (mine) return sending.discard(run, id, mine, true);
    const slot = items.findIndex((each) => each.id === qid);
    const message = textOf(qid);
    const parts = row?.queue?.items.find((each) => each.id === qid)?.parts?.parts ?? [message];
    editing.set({ qid, slot: Math.max(slot, 0), text: message });
    setField(parts);
    const put = words$.current;
    act({ kind: "remove", qid }, ["edit", qid], () => {
      if (editing.get()?.qid === qid) editing.set(null);
      // Words typed while it was asked stay.
      if (words$.current === put) setField([]);
    });
  };
  /** Sends the field as it is now; `chosen`, the paused queue's answer, read again from the field when it comes. */
  const submit = (other: boolean, chosen?: "now" | "queue"): void => {
    if (!connected) return;
    const parts = partsNow();
    const sent = waitingChips.of(id);
    const tiles = readyNow();
    // A `!` line runs on the Mac's shell, through the queue: shown whole and signed, the field kept till the Mac has it.
    // A worker's is a message, as on the desktop.
    const line = worker || toWorker ? null : shellOf(parts);
    if (line !== null) {
      if (!line) return;
      if (line.startsWith("--")) return setPowerError("A command can't start with --");
      setPowerError(null);
      // One whose reply was lost keeps its id when confirmed again: the Mac runs or queues an id once.
      const shellKey = `${id}\n${line}`;
      // An edit's id went with another line already (its reply lost): this line is a new command, not that edit.
      const spent = (qid: string) => [...mac.shells].some(([key, kept]) => kept === qid && key !== shellKey);
      if (editing.get() && spent(editing.get()!.qid)) editing.set(null);
      const pulled = editing.get();
      const qid = mac.shells.get(shellKey) ?? pulled?.qid ?? `c-${newId()}`;
      const typed = words$.current;
      return setPower({
        ...shellPower(id, line, qid, pulled?.slot),
        then: (reply) => {
          // Kept through refusals too ("Turned off…"): only the Mac taking this id lets it go.
          if (reply.error === "closed") mac.shells.set(shellKey, qid);
          else if (reply.ok && mac.shells.get(shellKey) === qid) mac.shells.delete(shellKey);
          if (!reply.ok) return setPowerError(refusal(reply));
          if (editing.get()?.qid === qid) editing.set(null);
          // Only the command leaves the field: a message given back above it while the sheet was open stays.
          const now = words$.current;
          if (now === typed) setField([]);
          else if (now.endsWith(`\n\n${typed}`)) setField(partsOf(now.slice(0, -typed.length - 2), named$.current));
        },
      });
    }
    if (waitsFor()) return;
    if (toWorker && !isEmpty({ parts, attachmentIds: tiles })) return sendTo(toWorker, parts, tiles, other);
    // With a To:, nothing falls to this session's own send: what waits above the field is this session's.
    if (to) return void (sent.length > 0 && setError("Clear the To: to send what waits to this session"));
    if (inProject && parts.some(isNew)) return submitNew(parts, tiles);
    if (isEmpty({ parts, attachmentIds: tiles }) && sent.length === 0) {
      // Held with nothing typed, it steers the first queued message [D183].
      if (other && running && canSteer && items[0]?.state === "queued" && !items[0].shell) steerQueued(items[0].id);
      return;
    }
    // The chips go after the words, and leave once it's sent or queued; a failed send keeps them in its message.
    const message = withChips(plainText(parts), sent);
    // The Mac reads words that start with `--` as a flag, so it refuses them.
    if (message.startsWith("--")) return setError("A message can't start with --");
    const draft = body(parts, sent, tiles);
    // Queue or Steer is the Mac's setting; the phone takes its default, Queue [D188]. A paused worker's waits till Resume [D3041].
    const mode = chosen ?? (row?.worker?.kind === "paused" ? "queue" : sendMode(running || commands, "queue", other, canSteer && running));
    if (!chosen && mode === "now" && paused && items.length > 0) {
      const count = items.length === 1 ? "One message waits" : `${items.length} messages wait`;
      return Alert.alert("Send message?", `The queue is paused. ${count} until you resume it. Send this one now, or keep it in the queue with them.`, [
        { text: "Keep paused", onPress: () => submit(other, "queue") },
        { text: "Send now", style: "default", onPress: () => submit(other, "now") },
      ]);
    }
    const msg = (mode === "queue" && editing.get()?.qid) || newId();
    goes(parts, sent, (pulled, sub) => (mode === "queue" ? queue(message, msg, pulled?.slot, gave(pulled), draft, sub) : sendNow(message, pulled, mode === "steer", msg, draft, sub)));
  };
  /**
   * To the worker alone, as the user's own message: steered (Send held, where it can) into its turn; else Rust gives it
   * now or holds it in this session's queue, "To ‹name›", till that worker's turn is over. Taken, the To: goes; refused,
   * the message and its To: come back [D3006, D3013, D3050].
   */
  const sendTo = (target: To, parts: Draft["parts"], tiles: string[], other: boolean) => {
    if (toSending || toGone) return;
    const [cid, message, draft] = [newId(), plainText(parts), payload(parts, tiles)];
    if (message.startsWith("--")) return setError("A message can't start with --");
    // A steer can't take files from here, nor another worker's mention, which the Mac reads as the target's [allow.rs
    // `send --from`]: with them it goes through the queue.
    const steer = tiles.length === 0 && !parts.some((part) => typeof part !== "string" && part.kind === "mention" && part.type === "worker") && sendMode(true, "queue", other, (lists.get().rows.find((each) => each.id === target.id) as ComposerRow | undefined)?.steer === true) === "steer";
    // A message pulled back to edit is never one for a worker here: it goes back to its place.
    const pulled = take();
    if (pulled) act({ kind: "add", qid: pulled.qid, text: pulled.text, slot: pulled.slot }, ["restore"]);
    fileStore.sent(id);
    setToSending(true);
    setError(null);
    const entry = { cid, target, args: toArgs(id, target.id, message, { qid: cid }, steer, draft), text: message, queued: !steer };
    void run(entry.args).then((reply) => {
      setToSending(false);
      const went = reply.ok || reply.result === "logged";
      if (went || unsure(reply)) setTo((now) => (now?.id === target.id ? null : now));
      if (went) return;
      // No answer, or one that can't say: it may have gone, so it waits under its own id for Try again or Discard.
      if (unsure(reply)) return mac.lostTo.put(id, cid, { ...entry, error: failure(reply) });
      // Refused: it waits on its own with Edit, never merged into a field that may be addressed elsewhere by now.
      mac.lostTo.put(id, cid, { ...entry, error: failure(reply), refused: { parts, tiles } });
    });
  };
  /** The message under `cid` as it's kept now; none once it went or was let go. */
  const keptLost = (cid: string) => mac.lostTo.of(id).find((each) => each.cid === cid);
  /** Settles `lost` from a reply to it, unless it was let go meanwhile. */
  const settleLost = (lost: ToLost, next: ToLost | null) => keptLost(lost.cid) && mac.lostTo.put(id, lost.cid, next);
  /** Try again: its own command, under its id; it stays kept unless the Mac took it, as a retry's refusal doesn't say the first never went. */
  const toAgain = (lost: ToLost) => {
    mac.lostTo.put(id, lost.cid, { ...lost, busy: true });
    void run(lost.args).then((reply) => settleLost(lost, reply.ok || reply.result === "logged" ? null : { ...lost, error: failure(reply) }));
  };
  /** Edit: a refused one's words and files back in an empty field, with its To:. */
  const toEdit = (lost: ToLost) => {
    if (!lost.refused || !isEmpty({ parts: partsNow(), attachmentIds: [...tilesNow()] })) return;
    mac.lostTo.put(id, lost.cid, null);
    setField(lost.refused.parts);
    fileStore.restore(id, lost.refused.tiles);
    setTo(lost.target);
  };
  /**
   * Discard: one through the queue is taken out of this session's queue, then the worker's, which it may have been handed
   * to meanwhile; it's let go only once both have taken it out. A steer can't be taken back, so it only stops showing here.
   */
  const toDiscard = (lost: ToLost) => {
    // A refused one never went anywhere.
    if (!lost.queued || lost.refused) return mac.lostTo.put(id, lost.cid, null);
    mac.lostTo.put(id, lost.cid, { ...lost, busy: true });
    void run(["queue", id, "remove", lost.cid])
      // A worker no longer listed has no queue left to hold it.
      .then((reply) => (reply.ok && lists.get().rows.some((each) => each.id === lost.target.id) ? run(["queue", lost.target.id, "remove", lost.cid]) : reply))
      .then((reply) => settleLost(lost, reply.ok ? null : { ...lost, error: failure(reply) }));
  };
  /**
   * Send as new, from a project's session (the /new chip): the message starts a new session there and the user stays.
   * Signed with Face ID (`side`), the field kept till the Mac has it; a new session takes no files from here [allow.rs].
   */
  const submitNew = (parts: Draft["parts"], tiles: readonly string[]) => {
    const rest = parts.filter((part) => !isNew(part));
    if (tiles.length > 0) return setError("Remove the files to send this as a new session");
    // `side` can't take what waits above the field from here [allow.rs], and they'd wait on here too.
    if (waitingChips.of(id).length > 0) return setError("What waits above the field can't go to a new session from iPhone: send it here first");
    if (isEmpty({ parts: rest, attachmentIds: [] })) return;
    // One string, shown on the sheet and signed as it is.
    const message = plainText(rest).trim();
    if (message.startsWith("--")) return setError("A message can't start with --");
    const pulled = editing.get();
    const draft = payload(rest, []);
    // One whose reply was lost is the same command confirmed again, its session's and message's ids kept, so Rust
    // carries on with it rather than making a second session.
    const key = `${id}\n${message}\n${draft ?? ""}`;
    const made = { id: sessionId(), cid: newId() };
    const args = mac.sides.get(key) ?? ["side", id, made.id, "--text", message, "--cid", made.cid, ...(pulled ? ["--qid", pulled.qid] : []), ...(draft ? ["--parts", draft] : [])];
    const was = words$.current;
    setPowerError(null);
    setPower({
      title: "Start as a new session?",
      body: NEW_SESSION.description,
      shown: message,
      args,
      then: (reply) => {
        // Only the command's own answer settles it: one lost, or stopped at the signature, keeps its ids.
        if (lostReply(reply) || unsigned(reply)) mac.sides.set(key, args);
        else mac.sides.delete(key);
        // With `session`, Rust logged it and this thread says how it went; without, nothing was made.
        if (!reply.ok || !reply.session) return setPowerError(reply.ok ? String(reply.message ?? "Refused") : refusal(reply));
        if (pulled && editing.get()?.qid === pulled.qid) editing.set(null);
        // Only the message leaves the field: one given back above it while the sheet was open stays.
        const now = words$.current;
        if (now === was) setField([]);
        else if (now.endsWith(`\n\n${was}`)) setField(partsOf(now.slice(0, -was.length - 2), named$.current));
      },
    });
  };
  const stop = () => {
    setStopping(true);
    setError(null);
    void run(["stop", id]).then((reply) => {
      if (reply.ok) return;
      setStopping(false);
      setError(failure(reply));
    });
  };
  const resume = () => act({ kind: "resume", qid: "" }, ["resume"]);
  const move = (qid: string, to: number) => new Promise<void>((resolve, reject) => act({ kind: "move", qid, done: resolve }, ["move", qid, String(to)], reject));
  return { act, steerQueued, edit, submit, toAgain, toEdit, toDiscard, stop, resume, move };
}
