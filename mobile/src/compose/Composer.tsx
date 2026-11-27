// The composer under a session's thread, as the desktop's session/composer.tsx and composer/composer.tsx lay it out
// and wire it [D183, D188, D363, D2108]: the rail (the night, Before you go, the queue) tucked under one card, which holds
// the tiles, the field and the footer (+, the level pill, Overnight, To ‹worker›, then status, the model and Send). Send,
// or while a turn runs Queue (hold Send to Steer, where the agent can); Stop and Resume; messages on their way with Try
// again and Discard, nothing sent again by itself; this phone's own draft kept on the Mac; `/`, `@` and +; `!` commands,
// Run in background, the level pill, Overnight and /new, each signed with Face ID [D57].
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { Alert, Animated, KeyboardAvoidingView, Modal, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useHeaderHeight } from "@react-navigation/elements";
import type { Chip as PanelChip } from "../../vendor/brigadier-shared/chips";
import { type Chip, type Draft, EMPTY_DRAFT, isEmpty, plainText, sendMode } from "../../vendor/brigadier-shared/draft";
import type { ModelRow } from "../../vendor/brigadier-shared/session/model";
import { inThread, type QueuedMessage, queuedOf, type RustQueued, toArgs } from "../../vendor/brigadier-shared/session/queued";
import { failure } from "../../vendor/brigadier-shared/session/run";
import { chipArgs, draftArgs, sendOp, sends } from "../../vendor/brigadier-shared/session/sent";
import type { Going } from "../../vendor/brigadier-shared/session/uncertain";
import type { Frame } from "../../vendor/brigadier-shared/client";
import { COMPACTION } from "../../vendor/brigadier-shared/words";
import { Confirm } from "../act/Confirm";
import { streamNow } from "../link";
import { lists, thread } from "../mac/mac";
import { color, mono, size, text } from "../theme";
import { LevelPill } from "../powers/Level";
import { NightReady, nightPlaceholder, OvernightPill, OvernightStrip, StartNight, useNight } from "../powers/Overnight";
import { backgroundPower, type Power, refusal, shellOf, shellPower } from "../powers/powers";
import { ImageSigns } from "../powers/View";
import { composerSample } from "../mac/sample";
import { Boxed, Glyph, Shimmer, Spinner, usePulse } from "./Glyph";
import { chipTone, type Command, Commands, Mentions, NEW_SESSION, OVERNIGHT, PlusMenu, useCommands } from "./Menus";
import { ModelPill } from "./Model";
import { Pill, PillDivider } from "./Pill";
import { QueueCard } from "./Queue";
import { ThreadImage } from "../thread/Image";
import { type Attachment, forMac, newId, type Picked, type ToLost, withChips } from "./state";

/** A session's row with what the composer needs from Rust, as the desktop's ComposerRow. */
type ComposerRow = ModelRow & {
  /** `editing`: the message pulled back to edit, kept by Rust; any device's. */
  queue?: { paused: boolean; items: RustQueued[]; editing?: { id: string; text: string; parts?: Draft; slot: number; to?: string; shell?: string } | null; running?: string[] } | null;
  steer?: boolean;
  /** The last turn was the user's Stop: Resume carries it on [D373]. */
  resumable?: boolean;
  holding?: boolean;
  /** A rebirth under way: its turn being stopped, or its fresh conversation not yet started [D88, D112]. */
  optimizing?: boolean;
};

/** One queue action, shown at once until its reply is in and Rust's row has caught up with it (`touched`). */
type Op = { key: string; kind: "add" | "remove" | "resume" | "move"; qid: string; text?: string; slot?: number; at?: number; done?: () => void };
/** The field's draft a message was sent from, its revision then, and its chips: what Rust gives back if it's refused. */
type Sub = { draft: Draft; rev: number | null; chips: readonly PanelChip[] };
type Pulled = { qid: string; slot: number; text: string } | null;

/** A chip in the text, which shows there as its label. */
type Named = Extract<Chip, { label: string }>;
const named = (part: Draft["parts"][number]): part is Named => typeof part !== "string" && "label" in part;

/** The field's text as a draft's parts: each chip still whole in it is a chip again, the rest words. */
function partsOf(words: string, chips: readonly Named[]): Draft["parts"] {
  const found: { chip: Named; at: number }[] = [];
  for (const chip of chips) {
    const n = chip.label.length;
    for (let at = words.indexOf(chip.label); n > 0 && at >= 0; at = words.indexOf(chip.label, at + 1)) {
      if (found.some((each) => at < each.at + each.chip.label.length && each.at < at + n)) continue;
      found.push({ chip, at });
      break;
    }
  }
  found.sort((a, b) => a.at - b.at);
  const parts: Draft["parts"] = [];
  let from = 0;
  for (const { chip, at } of found) {
    if (at > from) parts.push(words.slice(from, at));
    parts.push(chip);
    from = at + chip.label.length;
  }
  if (from < words.length) parts.push(words.slice(from));
  return parts;
}

/** The draft for Rust, which builds the agent's words from its parts and files; none for words alone (the desktop's files.tsx `payload`). */
const payload = (parts: Draft["parts"], tiles: readonly string[]) => (parts.some((part) => typeof part !== "string") || tiles.length > 0 ? JSON.stringify({ parts, attachmentIds: tiles }) : undefined);
/** The message's parts with the chips' words after them, as in the text, and its files. */
const body = (parts: Draft["parts"], sent: readonly PanelChip[], tiles: readonly string[]) =>
  payload(sent.length === 0 ? parts : [...parts, `${isEmpty({ parts, attachmentIds: [] }) ? "" : "\n\n"}${withChips("", sent)}`], tiles);

/** The desktop's home/start.ts sessionId: a new session's id, made here. */
const sessionId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
/** A reply lost with the link: what it asked may have been done. */
const lostReply = (reply: Record<string, any>) => reply.error === "closed" || reply.error === "disconnected";
/** Not a definite refusal: no answer, or one that says the worker's host may have it (`answered: false`, its I/O failing). */
const unsure = (reply: Record<string, any>) => lostReply(reply) || reply.answered === false;
/** Stopped before the command ran: the Mac's Face ID gate turned it down, so what it asked wasn't done. */
const unsigned = (reply: Record<string, any>) => ["Needs Face ID", "Turned off for this iPhone on your Mac", "no randomness"].includes(String(reply.error));
/** The worker a To: sends to, its name as it was picked. */
type To = { id: string; name: string };
const isNew = (part: Draft["parts"][number]) => typeof part !== "string" && part.kind === "command" && part.id === NEW_SESSION.id;

export function Composer({ id }: { id: string }) {
  const mac = forMac();
  const header = useHeaderHeight();
  const { run, unsaved, drafts, sends: sending, uncertain, chips: waitingChips, edits, files: fileStore } = mac;
  const row = useSyncExternalStore(lists.subscribe, () => lists.get().rows.find((each) => each.id === id)) as ComposerRow | undefined;
  const conn = useSyncExternalStore(lists.subscribe, () => (lists.get().ready ? streamNow() : -1));
  // A sample screen draws as if connected: nothing it asks goes anywhere.
  const connected = conn >= 0 || composerSample !== null;
  const session = useSyncExternalStore(thread.subscribe, () => (thread.get()?.id === id ? thread.get()?.session : null) ?? null);
  const going = useSyncExternalStore(uncertain.subscribe, () => uncertain.goingOf(id));
  const panel = useSyncExternalStore(waitingChips.chips.subscribe, () => waitingChips.of(id));
  const files = useSyncExternalStore(fileStore.owners.subscribe, () => fileStore.of(id));
  /** The tiles as they are now, and the ones that can go (a failed one is left out). */
  const tilesNow = () => fileStore.of(id).tiles;
  const readyNow = () => tilesNow().filter((each) => fileStore.of(id).all.get(each)?.state === "ready");

  // The field: its words, and the chips put in them, each shown as its label.
  const [initial] = useState(() => drafts.draftOf(id) ?? EMPTY_DRAFT);
  const [words, setWords] = useState(() => plainText(initial.parts));
  const named$ = useRef<Named[]>(initial.parts.filter(named));
  const words$ = useRef(words);
  const cursor = useRef(words.length);
  const [menu, setMenu] = useState<{ kind: "/" | "@"; query: string; from: number } | null>(null);
  /** The + menu is open; `opened` counts the menus opened, each asking for the commands again. */
  const [plus, setPlus] = useState(false);
  const [opened, setOpened] = useState(0);
  /** The To: the worker the next message goes to alone (@ › Message directly); leaving the session takes it away. */
  // Kept apart from its row: a worker gone from the list keeps its To:, and Send waits till the user changes it.
  const [to, setTo] = useState<To | null>(null);
  const [toSending, setToSending] = useState(false);
  /** Messages to workers whose reply was lost: they may have gone, so each is kept with its command, tried again as itself. */
  const toLost = useSyncExternalStore(mac.lostTo.store.subscribe, () => mac.lostTo.of(id));
  // One through the queue that's in Rust's queue now went: settled.
  useEffect(() => {
    for (const lost of toLost) if (lost.queued && row?.queue?.items.some((each) => each.id === lost.cid)) mac.lostTo.put(id, lost.cid, null);
  });
  const toRow = useSyncExternalStore(lists.subscribe, () => (to ? lists.get().rows.find((each) => each.id === to.id && each.worker?.parent === id) : undefined));
  const toWorker = to && { id: to.id, name: toRow?.title || to.name };
  const toGone = to !== null && !toRow;
  const worker = Boolean(row?.worker);
  const partsNow = () => partsOf(words$.current, named$.current);
  // A `!` first makes the field a shell command, shown without its `!` [D316]: never a worker's, nor with a To:.
  const shell = !worker && !toWorker && shellOf(partsOf(words, named$.current)) !== null;
  const empty = isEmpty({ parts: shell ? [words.slice(1)] : partsOf(words, named$.current), attachmentIds: files.tiles.filter((each) => files.all.get(each)?.state !== "failed") });
  /** Keeps what the field holds, its files' ids too, as this phone's draft on the Mac. */
  const keep = (parts: Draft["parts"]) => drafts.keepDraft(run, id, { parts, attachmentIds: [...tilesNow()] });
  /** Puts `parts` in the field; `save`, kept as the draft too, as a change typed is. */
  const setField = (parts: Draft["parts"], save = true) => {
    words$.current = plainText(parts);
    named$.current = parts.filter(named);
    cursor.current = words$.current.length;
    setWords(words$.current);
    setMenu(null);
    setPlus(false);
    if (save) keep(parts);
  };

  const [ops, setOps] = useState<Op[]>([]);
  const [error, setError] = useState<string | null>(() => drafts.givenError(id));
  const [stopping, setStopping] = useState(false);
  /** The Face ID sheet for a `!` command or Run in background, and what its reply does. */
  const [power, setPower] = useState<(Power & { then: (reply: Frame) => void }) | null>(null);
  /** A power's refusal, shown on its own line: the queue's errors don't hide it. */
  const [powerError, setPowerError] = useState<string | null>(null);
  /** An image tile opened whole. */
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const editing = { get: () => edits.get(id) ?? null, set: (pulled: Pulled) => void (pulled ? edits.set(id, pulled) : edits.delete(id)) };

  // A message pulled back to edit that this phone can't prove is its own (another device's, or from before a relaunch)
  // is never claimed: the queue card offers Put back instead.
  const kept = row?.queue?.editing;
  const foreign = kept && edits.get(id)?.qid !== kept.id ? kept : null;
  // After a restart the draft is Rust's alone: it comes back unless something was typed first. One given back while
  // the session was closed brings its tiles; its files' names are read from Rust's folder.
  useEffect(() => {
    fileStore.restore(id, initial.attachmentIds);
    fileStore.load(id);
    void drafts.loadDraft(run, id).then((saved) => {
      if (!saved || !isEmpty({ parts: partsNow(), attachmentIds: [] })) return;
      setField(saved.parts, false);
      fileStore.restore(id, saved.attachmentIds);
    });
  }, []);
  // The tiles changed: the draft keeps them.
  const shownTiles = useRef(files.tiles);
  useEffect(() => {
    if (shownTiles.current === files.tiles) return;
    shownTiles.current = files.tiles;
    keep(partsNow());
  }, [files.tiles]);
  // A message Rust gave back goes above what's typed since, never over it [D363].
  useEffect(() =>
    drafts.onGiven(id, (back) => {
      const typed = partsNow();
      const parts = isEmpty({ parts: typed, attachmentIds: [] }) ? back.parts : [...back.parts, "\n\n", ...typed];
      setField(parts, false);
      fileStore.restore(id, back.attachmentIds);
      if (back.error) setError(back.error);
      return { parts, attachmentIds: [...new Set([...back.attachmentIds, ...tilesNow()])] };
    }),
  );
  // Each connection: what waits above the field, read again; messages Rust may not hold handed to it, a Delete told instead (the desktop's sent.tsx `useHanding`).
  useEffect(() => {
    if (!connected) return;
    waitingChips.load(id);
    // The files are read again: one Rust's folder lost shows failed.
    fileStore.load(id, true);
    // A save or read refused while away goes now, stale if it missed a give-back.
    if (unsaved.delete(id)) drafts.resyncDraft(run, id);
  }, [conn]);
  useEffect(() => {
    if (!connected) return;
    for (const each of going.filter((one) => (!one.booked || one.removing) && sending.asked.get(one.cid) !== conn)) {
      sending.asked.set(each.cid, conn);
      void (each.removing ? uncertain.tellDrops(run, id) : sending.adopt(run, id, each));
    }
  });
  // In the thread now: it leaves the messages on their way, and the queue [D30].
  const delivered = inThread(session);
  useEffect(() => {
    for (const each of sends(going).filter((one) => delivered.has(one.cid))) uncertain.forget(id, each.cid);
  });

  // The turn as the thread shows it, Rust's row until the thread is this session's (the desktop's session/turn.ts).
  const turn = session?.after == null ? session?.turns.at(-1) : undefined;
  const onItsWay = sends(going).some((each) => each.stuck === undefined);
  const holds = row === undefined || row.holding === true || row.running === true;
  const running = turn ? turn.status === "running" || (turn.held === true && holds) : row?.running === true || row?.holding === true;
  const resumable = !onItsWay && (turn ? turn.status === "cancelled" && (row?.resumable === true || row?.running === true) : row?.resumable === true);
  const busy = running || onItsWay;
  useEffect(() => {
    if (!busy) setStopping(false);
  }, [busy]);
  const canSteer = row?.steer === true;
  // A worker's own tab has no Stop or Resume, no level, Overnight, /new or `!` [D293].
  const canStop = busy && connected && !worker;
  const night = useNight(id, row);
  // Its turn's last questions are in the thread already, waiting or answered.
  const lastTurn = session?.turns.at(-1)?.id;
  const asked = lastTurn !== undefined && (session?.items.some((item) => item.kind === "question" && item.turnId === lastTurn) ?? false);
  const inProject = Boolean(row?.project) && !worker;
  const { listed, chats } = useCommands(id, running, opened);
  const extra: Command[] = worker ? [] : [...(inProject ? [NEW_SESSION] : []), OVERNIGHT];

  // Rust's queue, with this phone's actions on it shown at once and its adds Rust may not hold.
  const touched = row?.touched ?? 0;
  const live = ops.filter((op) => op.at === undefined || touched < op.at);
  useEffect(() => {
    if (live.length === ops.length) return;
    ops.filter((op) => !live.includes(op)).forEach((op) => op.done?.());
    setOps(live);
  });
  const queueGoing = going.filter((each) => each.kind === "queue" && !each.removing);
  const lost = (qid: string) => queueGoing.find((each) => each.cid === qid);
  let paused = row?.queue?.paused === true;
  const queued = (row?.queue?.items ?? []).filter((each) => (each.shell === "ended" ? paused || each.error : !delivered.has(each.id)));
  let items: QueuedMessage[] = queuedOf(queued, lists.get().rows);
  for (const op of live) {
    if (op.kind === "remove") items = items.filter((each) => each.id !== op.qid);
    if (op.kind === "resume") paused = false;
    if (op.kind === "add" && !delivered.has(op.qid) && !items.some((each) => each.id === op.qid)) {
      items = [...items];
      items.splice(op.slot ?? items.length, 0, { id: op.qid, draft: { parts: [op.text ?? ""], attachmentIds: [] }, state: "local" });
    }
  }
  items = [...items, ...queueGoing.filter((each) => !delivered.has(each.cid) && !items.some((one) => one.id === each.cid)).map((each): QueuedMessage => ({ id: each.cid, draft: each.draft, state: each.stuck === undefined ? "local" : each.reached === false ? "unadded" : "uncertain" }))];
  const textOf = (qid: string) => row?.queue?.items.find((each) => each.id === qid)?.text ?? live.find((op) => op.qid === qid)?.text ?? "";
  const commands = (row?.queue?.running?.length ?? 0) > 0;
  const runningCommands = (row?.queue?.running ?? []).map((cmd) => {
    const ran = session?.items.find((each) => each.kind === "shell" && each.cmd === cmd);
    return { id: cmd, line: ran?.kind === "shell" ? ran.command : "" };
  });

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
      // Refused: its words come back as Rust's give-backs do, into the composer open now or the draft kept [D363].
      drafts.takeBack(run, id, { cid, parts, attachmentIds: tiles, error: failure(reply) });
      setTo(target);
    });
  };
  /** Try again: its own command, under its id; it stays kept unless the Mac took it, as a retry's refusal doesn't say the first never went. */
  const toAgain = (lost: ToLost) =>
    void run(lost.args).then((reply) => mac.lostTo.put(id, lost.cid, reply.ok || reply.result === "logged" ? null : { ...lost, error: failure(reply) }));
  /**
   * Discard: one through the queue is taken out of this session's queue, then the worker's, which it may have been handed
   * to meanwhile; it's let go only once both have taken it out. A steer can't be taken back, so it only stops showing here.
   */
  const toDiscard = (lost: ToLost) => {
    if (!lost.queued) return mac.lostTo.put(id, lost.cid, null);
    void run(["queue", id, "remove", lost.cid])
      // A worker no longer listed has no queue left to hold it.
      .then((reply) => (reply.ok && lists.get().rows.some((each) => each.id === lost.target.id) ? run(["queue", lost.target.id, "remove", lost.cid]) : reply))
      .then((reply) => mac.lostTo.put(id, lost.cid, reply.ok ? null : { ...lost, error: failure(reply) }));
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
  const resuming = live.some((op) => op.kind === "resume");
  const move = (qid: string, to: number) => new Promise<void>((resolve, reject) => act({ kind: "move", qid, done: resolve }, ["move", qid, String(to)], reject));
  const stuck = row?.queue?.items.find((each) => each.error);

  /** Typed: kept as the draft; emptied while a queued message was pulled back, that message goes back to its place. */
  const typed = (next: string) => {
    words$.current = next;
    setWords(next);
    setPlus(false);
    const parts = partsNow();
    named$.current = parts.filter(named);
    keep(parts);
    const pulled = editing.get();
    if (pulled && isEmpty({ parts, attachmentIds: [] })) {
      editing.set(null);
      act({ kind: "add", qid: pulled.qid, text: pulled.text, slot: pulled.slot }, ["restore"]);
    }
  };
  // The `/` or `@` the caret is just after, at a word's start, and what's typed after it.
  const lookAt = (at: number) => {
    // A command's field shows it without its `!`, and has no menus.
    cursor.current = at + (shell ? 1 : 0);
    if (shell) return setMenu(null);
    const hit = /(^|\s)([@/])([^\s@/]*)$/.exec(words$.current.slice(0, at));
    // A `/` menu opening asks for the commands again: Settings › Plugins may have changed since.
    if (hit?.[2] === "/" && menu?.kind !== "/") setOpened((times) => times + 1);
    setMenu(hit ? { kind: hit[2] as "/" | "@", query: hit[3], from: at - hit[3].length - 1 } : null);
  };
  /** The trigger and its query give way to `put` (a chip's label, and a space). */
  const replace = (put: string, chip?: Named) => {
    if (!menu) return;
    const now = words$.current;
    const next = now.slice(0, menu.from) + put + now.slice(cursor.current);
    if (chip) named$.current = [...named$.current, chip];
    words$.current = next;
    cursor.current = menu.from + put.length;
    setWords(next);
    setMenu(null);
    keep(partsNow());
  };
  const runCommand = (command: Command) => {
    replace("");
    setPlus(false);
    void run(["command", id, command.label.slice(1)]).then((reply) => !reply.ok && setError(String(reply.error ?? `Couldn't run ${command.label}`)));
  };
  /** A `/` or + pick: /overnight turns it on or off, an instant command runs, any other goes in the text as its chip. */
  const pickCommand = (command: Command, put: (chip: Named) => void) => {
    if (command.id === OVERNIGHT.id) {
      replace("");
      setPlus(false);
      return night.ask(night.now ? "off" : "on");
    }
    if (command.instant) return runCommand(command);
    put({ kind: "command", id: command.id, type: command.kind, label: command.label });
  };
  /** A chip from the + menu where the caret last was, spaced off what's around it. */
  const insert = (chip: Named) => {
    const now = words$.current;
    const at = Math.min(cursor.current, now.length);
    const put = `${at > 0 && !/\s$/.test(now.slice(0, at)) ? " " : ""}${chip.label} `;
    named$.current = [...named$.current, chip];
    words$.current = now.slice(0, at) + put + now.slice(at);
    cursor.current = at + put.length;
    setWords(words$.current);
    setPlus(false);
    keep(partsNow());
  };

  /** Why Send waits now, in the desktop's words; none when it can go. */
  const waitsFor = () => {
    const now = fileStore.of(id);
    const tiles = now.tiles.flatMap((each) => now.all.get(each) ?? []);
    if (tiles.some((each) => each.state === "uploading")) return "Files uploading…";
    // Kept in the draft, not read from Rust's folder yet.
    if (tiles.length < now.tiles.length) return "Files loading…";
    if (tiles.some((each) => each.state === "ready" && each.mime.startsWith("image/")) && !mac.models.takesImages(row?.backend, row?.model)) return "This model does not support image inputs. Try a different model";
    return undefined;
  };
  const waits = waitsFor();
  const add = (picked: Picked[]) => picked.forEach((each) => fileStore.attach(id, each, row?.backend));
  const photos = () => {
    setPlus(false);
    void ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible }).then((got) => !got.canceled && add(got.assets.map((each) => ({ uri: each.uri, name: each.fileName || `Image.${each.mimeType?.split("/")[1] ?? "jpg"}`, mime: each.mimeType, size: each.fileSize }))), () => setError("Couldn't open your photos"));
  };
  const documents = () => {
    setPlus(false);
    void DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true }).then((got) => !got.canceled && add(got.assets.map((each) => ({ uri: each.uri, name: each.name, mime: each.mimeType, size: each.size }))), () => setError("Couldn't open Files"));
  };

  // Nothing to send: no words, no files, and nothing waiting above the field.
  const blank = empty && panel.length === 0;
  const state = canStop && blank && !shell ? "stop" : !running && blank && resumable && !worker && !shell ? "resume" : "send";
  const press = () => (state === "stop" ? stop() : state === "resume" ? resume() : submit(false));
  // Held, Send steers, into the running turn or a To: worker's; always set, so the release after a long press isn't
  // also a tap (a steer turns the button into Stop meanwhile).
  const steers = state === "send" && !shell && (toWorker !== null || (running && canSteer));
  const hold = () => (steers ? submit(true) : press());
  const verb = running && !blank ? "Queue" : "Send message";
  // Why Send waits, in the desktop's words: offline it says so, as it does.
  const held = connected ? undefined : "Reconnecting…";
  const gone = toGone ? `${to.name} is no longer on your Mac` : undefined;
  const blocked = held ?? waits ?? gone ?? (toSending ? `Send to ${toWorker?.name ?? "the worker"}` : undefined);
  const runs = state === "send" && shell;
  const tip = state === "stop" ? "Stop" : state === "resume" ? "Resume" : (blocked ?? (runs ? (running || commands ? "Run when the turn ends" : "Run command") : toWorker ? `Send to ${toWorker.name}` : verb));
  const off = (state === "send" && (blank || blocked !== undefined)) || (state === "stop" && stopping) || (state === "resume" && (resuming || !connected));
  const shownSends = sends(going).filter((each) => !delivered.has(each.cid));
  const pulled = foreign && !live.some((op) => op.qid === foreign.id) ? { text: foreign.parts ? plainText(foreign.parts.parts) : foreign.text, onPutBack: () => act({ kind: "add", qid: foreign.id, text: foreign.text, slot: foreign.slot }, ["restore"]) } : null;
  // The rail's items, in the desktop's order; each after the first ruled off from the one above.
  const rail = [
    night.now?.state === "night" ? <OvernightStrip key="night" night={night} connected={connected} /> : null,
    night.now?.state === "ready" ? <NightReady key="ready" night={night} connected={connected} /> : null,
    // Under the turn's last questions on the desktop; here they're in the thread, so it waits on the rail meanwhile.
    night.now?.state === "asking" && asked && session?.questions?.length ? <StartNight key="start" label="Or start now: it picks what you skip and tells you in the morning" night={night} connected={connected} /> : null,
    items.length > 0 || runningCommands.length > 0 || pulled ? (
      <QueueCard
        key="queue"
        items={items}
        running={runningCommands}
        paused={paused}
        resuming={resuming || stopping || !connected}
        steer={canSteer && running}
        canEdit={empty}
        error={(stuck ? `Not sent: ${stuck.error}. ${stuck.to ? "Edit it, delete it or send it to the session instead." : "Edit or delete it to go on."}` : null) ?? (items.length > 0 ? error : null)}
        onResume={worker ? undefined : resume}
        onBackground={(command) => setPower({ ...backgroundPower(id, command.id, command.line), then: (reply) => setPowerError(reply.ok ? null : refusal(reply)) })}
        onSteer={steerQueued}
        onRemove={(qid) => (lost(qid) ? sending.discard(run, id, lost(qid)!) : act({ kind: "remove", qid }, ["remove", qid]))}
        onEdit={edit}
        onAddAgain={(qid) => void sending.again(run, id, lost(qid)!)}
        onToSession={(qid) => {
          const parts = row?.queue?.items.find((each) => each.id === qid)?.parts;
          act({ kind: "add", qid, text: textOf(qid) }, ["add", textOf(qid), "--qid", qid, ...(parts ? ["--parts", JSON.stringify(parts)] : [])]);
        }}
        onMove={move}
        pulled={pulled}
      />
    ) : null,
  ].filter(Boolean);
  // The night's look, but not on a command [D316].
  const look = shell ? st.shell : night.now ? st.night : null;
  const shownError = powerError ?? night.error ?? (items.length === 0 ? error : null);
  const placeholder = shell ? "Run a command" : toWorker ? `Message ${toWorker.name}` : (nightPlaceholder(night.now, busy, asked) ?? "Do anything");
  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={header}>
      <SafeAreaView edges={{ bottom: "maximum" }} style={st.column}>
        {shownSends.map((each) => <OnItsWay key={each.cid} entry={each} id={id} />)}
        {toLost.map((lost) => (
          <View key={lost.cid} style={st.going}>
            <Text style={st.goingText} numberOfLines={3}>{lost.text}</Text>
            <Text style={st.error}>May have been sent to {lost.target.name} · {lost.error}</Text>
            {lost.queued ? null : <Text style={st.muted}>If it went, it still reaches {lost.target.name}</Text>}
            <View style={st.actions}>
              <Link title="Try again" onPress={() => toAgain(lost)} />
              <Link title={lost.queued ? "Discard" : "Stop showing"} onPress={() => toDiscard(lost)} />
            </View>
          </View>
        ))}
        {/* A menu takes the rail's place, just over the card. */}
        {menu?.kind === "/" ? (
          <Commands listed={listed} extra={extra} query={menu.query} onPick={(command) => pickCommand(command, (chip) => replace(`${chip.label} `, chip))} />
        ) : menu?.kind === "@" ? (
          <Mentions
            id={id}
            query={menu.query}
            onPick={(item) => replace(`${item.label} `, { kind: "mention", id: item.id, type: item.type as Extract<Named, { kind: "mention" }>["type"], label: item.label })}
            onDirect={(target) => {
              // Message directly leaves no mention in the text: only the To: chip.
              replace("");
              setTo({ id: target.id, name: target.name ?? target.label });
            }}
          />
        ) : plus ? (
          <PlusMenu listed={listed} chats={chats} onPhotos={photos} onFiles={documents} onCommand={(command) => pickCommand(command, insert)} onChat={(chat) => insert({ kind: "mention", id: chat.id, type: "chat", label: chat.label })} />
        ) : rail.length > 0 ? (
          <View style={st.rail}>{rail.map((item, at) => <View key={at} style={at > 0 && st.ruled}>{item}</View>)}</View>
        ) : null}
        <View style={[st.card, look]}>
          {files.tiles.length > 0 || panel.length > 0 ? (
            <View style={st.tiles}>
              {files.tiles.map((each) => {
                const file = files.all.get(each);
                return <Tile key={each} owner={id} file={file ?? { id: each, name: "Loading…", mime: "", state: "uploading" }} onOpen={() => setViewing(file ?? null)} onRemove={() => fileStore.remove(id, each)} />;
              })}
              {panel.map((chip) => <ChipTile key={chip.id} chip={chip} />)}
            </View>
          ) : null}
          <Field words={words} chips={named$.current} shell={shell} placeholder={placeholder} night={night.now !== null} onChange={typed} onCursor={lookAt} />
          <View style={st.footer}>
            {shell ? (
              <Text style={st.shellWords} numberOfLines={1}>Shell command</Text>
            ) : (
              <>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Add files and more"
                  accessibilityState={{ expanded: plus }}
                  onPress={() => {
                    setMenu(null);
                    if (!plus) setOpened((times) => times + 1);
                    setPlus(!plus);
                  }}
                  hitSlop={(size.touch - size.controlSm) / 2}
                  style={({ pressed }) => [st.plus, (pressed || plus) && { backgroundColor: color.fill }]}
                >
                  <Glyph name="plus" size={20} color={color.primary} />
                </Pressable>
                {!worker ? <LevelPill id={id} row={row} connected={connected} /> : null}
                {!worker ? <OvernightPill night={night} connected={connected} /> : null}
                {toWorker ? (
                  <>
                    <PillDivider />
                    <Pill label={`To ${toWorker.name}: send to this session instead`} selected disabled={toSending} onPress={() => setTo(null)} style={{ maxWidth: 192 }}>
                      <Text style={st.toDot}>●</Text>
                      <Text style={st.pillText} numberOfLines={1}>To {toWorker.name}</Text>
                    </Pill>
                  </>
                ) : null}
              </>
            )}
            {/* The end's parts wrap under the tools as one, short of room. */}
            <View style={st.end}>
              {row?.optimizing ? <Shimmer style={st.status}>{COMPACTION.running}</Shimmer> : shownError ? <Text style={[st.status, { color: color.destructive }]} numberOfLines={2}>{shownError}</Text> : null}
              {!shell ? <ModelPill id={id} row={row} connected={connected} open={composerSample === "composer-model"} /> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={tip}
                accessibilityHint={steers ? "Hold to steer it into the running turn" : undefined}
                accessibilityState={{ disabled: off }}
                disabled={off}
                onPress={press}
                onLongPress={hold}
                hitSlop={(size.touch - size.controlSm) / 2}
                style={({ pressed }) => [runs ? st.run : st.send, off ? { opacity: size.disabled } : pressed && { opacity: 0.8 }]}
              >
                {state === "stop" ? <View style={st.stop} /> : state === "resume" ? <Glyph name="play" size={size.iconSm} color={color.primaryFg} /> : runs ? <Text style={st.runText}>Run</Text> : <Glyph name="arrowUp" color={color.primaryFg} weight="700" />}
              </Pressable>
            </View>
          </View>
        </View>
        {/* Why Send waits: the desktop's tip for it, which a phone can't hover. */}
        {(held ?? waits ?? gone) && (!blank || held || gone) ? <Text style={st.waits}>{held ?? waits ?? gone}</Text> : null}
        <ImageSigns />
        {night.sheet}
        {power ? (
          <Confirm
            title={power.title}
            body={power.body}
            shown={power.shown}
            args={power.args}
            onDone={(reply) => {
              setPower(null);
              if (reply) power.then(reply);
            }}
          />
        ) : null}
        {viewing ? <Viewer owner={id} file={viewing} onClose={() => setViewing(null)} /> : null}
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

/**
 * The field, as the desktop's field.tsx: at least 44 tall, a quarter of the screen at most, then it scrolls and fades
 * at its top; each chip in its kind's colour. A command shows without its `!`, in mono after the Terminal icon;
 * Backspace in an empty one leaves the mode, as deleting the `!` would.
 */
function Field({ words, chips, shell, placeholder, night, onChange, onCursor }: { words: string; chips: readonly Named[]; shell: boolean; placeholder: string; night: boolean; onChange: (next: string) => void; onCursor: (at: number) => void }) {
  const { height } = useWindowDimensions();
  const [scrolled, setScrolled] = useState(false);
  const under = night && !shell ? color.surfaceUnder : color.composer;
  return (
    <View>
      {shell ? (
        <View style={st.terminal} pointerEvents="none">
          <Boxed mark=">_" color={color.link} />
        </View>
      ) : null}
      <TextInput
        style={[st.input, { maxHeight: height * 0.25 }, shell && st.mono]}
        multiline
        placeholder={placeholder}
        placeholderTextColor={color.placeholder}
        onChangeText={(next) => onChange(shell ? `!${next}` : next)}
        onKeyPress={(event) => shell && words === "!" && event.nativeEvent.key === "Backspace" && onChange("")}
        onSelectionChange={(event) => onCursor(event.nativeEvent.selection.end)}
        onScroll={(event) => setScrolled(event.nativeEvent.contentOffset.y > 0)}
        accessibilityLabel={shell ? "Shell command input" : "Message"}
      >
        {shell ? words.slice(1) : segments(words, chips).map(([part, chip], at) => <Text key={at} style={chip && { color: chipTone(chip) }}>{part}</Text>)}
      </TextInput>
      {scrolled ? <View pointerEvents="none" style={[st.fade, { experimental_backgroundImage: `linear-gradient(to bottom, ${under}, transparent)` }]} /> : null}
    </View>
  );
}

/** The field's words cut at each chip, so a chip is drawn as one. */
function segments(words: string, chips: readonly Named[]): [string, Named | null][] {
  return partsOf(words, chips).map((part) => (typeof part === "string" ? [part, null] : [(part as Named).label, part as Named]));
}

/** "PDF", "PNG image", "Text": what a file's tile says under its name (the desktop's attachments.tsx `kindOf`). */
function kindOf(name: string, mime: string): string {
  if (mime === "application/pdf") return "PDF";
  const extension = name.includes(".") ? name.split(".").pop()?.toUpperCase() : undefined;
  if (mime.startsWith("image/")) return extension ? `${extension} image` : "Image";
  if (mime.startsWith("text/")) return extension ? `${extension} text` : "Text";
  return extension ? `${extension} file` : "File";
}

const baseName = (name: string) => name.slice(name.lastIndexOf("/") + 1);

/**
 * A tile's ✕: a dark dot inside its corner. Its reach grows out to the corner, and on a card down and in too; on an
 * image it stops short of the middle, which opens the image.
 */
const Remove = ({ label, onPress, image }: { label: string; onPress: () => void; image: boolean }) => (
  <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={image ? { top: 6, right: 6, left: 4, bottom: 4 } : 14} style={st.remove}>
    <Glyph name="x" size={9} color={color.background} weight="700" />
  </Pressable>
);

/** A card in the tiles row: an icon in its box, a title over a second line, and its ✕ where it has one. */
function Card({ icon, title, detail, invalid, children }: { icon: React.ReactNode; title: string; detail: string; invalid?: boolean; children?: React.ReactNode }) {
  return (
    <View accessible accessibilityLabel={`${title}, ${detail}`} style={[st.fileCard, invalid && { borderColor: color.invalid }]}>
      <View style={st.iconBox}>{icon}</View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={st.cardTitle} numberOfLines={1}>{title}</Text>
        <Text style={st.cardDetail} numberOfLines={1}>{detail}</Text>
      </View>
      {children}
    </View>
  );
}

/**
 * A file over the field: an image as a rounded thumbnail, pulsing till Rust has it with a spinner over it; any other
 * as a card with its kind, Attaching… or why it failed, red-edged then. A tap opens an image whole.
 */
function Tile({ owner, file, onOpen, onRemove }: { owner: string; file: Attachment; onOpen: () => void; onRemove: () => void }) {
  const name = baseName(file.name);
  const image = file.mime.startsWith("image/") && file.state !== "failed";
  const remove = <Remove label={`Remove ${name}`} onPress={onRemove} image={image} />;
  if (image) {
    return (
      <View style={st.thumb}>
        {file.state === "ready" ? (
          <>
            <ThreadImage owner={owner} attachment={file.id} mime={file.mime} label={file.name} style={StyleSheet.absoluteFill} />
            <Pressable accessibilityRole="button" accessibilityLabel={`Preview ${file.name}`} onPress={onOpen} style={StyleSheet.absoluteFill} />
          </>
        ) : (
          <Pulsing />
        )}
        <View pointerEvents="none" style={st.ring} />
        {file.state === "uploading" ? (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, st.centred]}>
            <Spinner />
          </View>
        ) : null}
        {remove}
      </View>
    );
  }
  const failed = file.state === "failed";
  const icon = failed ? <Glyph name="warning" color={color.destructive} label="Upload failed" /> : file.state === "uploading" ? <Spinner /> : <Glyph name={file.mime.startsWith("image/") ? "image" : file.mime.startsWith("text/") || file.mime === "application/pdf" ? "document" : "file"} color={color.mutedForeground} />;
  return (
    <Card icon={icon} title={name} detail={failed ? (file.error ?? "Couldn't attach this file") : file.state === "uploading" ? "Attaching…" : kindOf(file.name, file.mime)} invalid={failed}>
      {remove}
    </Card>
  );
}

/** An image's box till its bytes are in. */
const Pulsing = () => <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color.muted, opacity: usePulse() }]} />;

const plural = (n: number, one: string) => (n === 1 ? `1 ${one}` : `${n} ${one}s`);

/**
 * What waits above the field for the agent, as the desktop's CommentChip and AgentChipTile: a diff comment, a Resolve or
 * a Fix with agent. A phone only reads them and sends them with its next message, so no ✕ [allow.rs `chips`].
 */
function ChipTile({ chip }: { chip: PanelChip }) {
  if (chip.kind === "comment") {
    const { path, start, end, text: said, excerpt } = chip.comment;
    return <Card icon={<Glyph name="comment" color={color.mutedForeground} />} title={said} detail={`${baseName(path)}:${start === end ? start : `${start}–${end}`}  ${excerpt}`} />;
  }
  const agent = chip.chip;
  return agent.kind === "resolve" ? (
    <Card icon={<Glyph name="sparkles" color={color.mutedForeground} />} title={`Resolve ${plural(agent.conflicts, "conflict")}`} detail={`${plural(agent.files, "file")} · ${agent.operation} ${agent.onto}`} />
  ) : (
    <Card icon={<Glyph name="xCircle" color={color.destructive} />} title={`Fix ${agent.run}`} detail={agent.failed} />
  );
}

/** An image tile opened whole, as the desktop's viewer; held, it saves to Photos. */
function Viewer({ owner, file, onClose }: { owner: string; file: Attachment; onClose: () => void }) {
  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <SafeAreaView style={st.viewer}>
        <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12} style={st.done}>
          <Text style={st.doneText}>Done</Text>
        </Pressable>
        <ThreadImage owner={owner} attachment={file.id} mime={file.mime} label={file.name} style={{ flex: 1 }} whole />
      </SafeAreaView>
    </Modal>
  );
}

/** A message on its way, as the desktop's sent.tsx bubbles: sending, or why not with Try again, Discard and Edit. */
function OnItsWay({ id, entry }: { id: string; entry: Going }) {
  const { run, sends: sending } = forMac();
  const failed = entry.stuck;
  // One that may have reached its agent is only tried again, under its id [C75].
  const maybe = entry.reached !== false;
  return (
    <View style={st.going}>
      <Text style={st.goingText} numberOfLines={3}>{entry.op[2] ?? plainText(entry.draft.parts)}</Text>
      <Text style={failed ? st.error : st.muted}>{failed ? `${maybe ? "May have been sent" : "Not sent"} · ${failed}` : "Sending…"}</Text>
      {failed ? (
        <View style={st.actions}>
          {entry.op.length > 0 ? <Link title="Try again" onPress={() => void sending.again(run, id, entry)} /> : null}
          {!maybe ? <Link title="Edit" onPress={() => sending.discard(run, id, entry, true)} /> : null}
          {!maybe ? <Link title="Discard" onPress={() => sending.discard(run, id, entry)} /> : null}
        </View>
      ) : null}
    </View>
  );
}

const Link = ({ title, onPress }: { title: string; onPress: () => void }) => (
  <Pressable accessibilityRole="button" onPress={onPress} hitSlop={8}>
    <Text style={st.link}>{title}</Text>
  </Pressable>
);

const st = StyleSheet.create({
  // 12 under the card (pb-3), or the home indicator's inset where that's more.
  column: { gap: 8, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: color.background },
  // The gap above the card is taken back, and the tuck under its top edge.
  rail: { marginHorizontal: size.railInset, marginBottom: -size.railTuck - 8, paddingBottom: size.railTuck, borderTopLeftRadius: size.radiusOverlay, borderTopRightRadius: size.radiusOverlay, borderWidth: 1, borderBottomWidth: 0, borderColor: color.border, backgroundColor: color.codeSurface, overflow: "hidden" },
  ruled: { borderTopWidth: 1, borderTopColor: color.border },
  card: { gap: 4, padding: 8, borderRadius: size.radiusComposer, backgroundColor: color.composer, boxShadow: color.composerGlow },
  // overnight.css `night-sky`: the page's darkest fill, a violet glow from the end corner and a blue one from the start.
  night: { backgroundColor: color.surfaceUnder, boxShadow: `inset 0 0 0 1px ${color.picked}`, experimental_backgroundImage: "radial-gradient(ellipse at top right, rgba(177,151,252,0.34), transparent 360px), radial-gradient(ellipse at bottom left, rgba(2,133,255,0.34), transparent 320px)" },
  shell: { boxShadow: `${color.composerGlow}, 0 0 0 1px ${color.link}` },
  input: { ...text.base, color: color.foreground, minHeight: size.composer, paddingHorizontal: 8, paddingTop: 10, paddingBottom: 10 },
  mono: { fontFamily: mono, paddingLeft: 36 },
  terminal: { position: "absolute", left: 8, top: 14, zIndex: 1 },
  fade: { position: "absolute", left: 0, right: 0, top: 0, height: 16 },
  footer: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 2 },
  shellWords: { ...text.sm, color: color.link, paddingHorizontal: 8, height: size.controlSm, lineHeight: size.controlSm, flexShrink: 1 },
  plus: { width: size.controlSm, height: size.controlSm, borderRadius: size.radiusIconButton, alignItems: "center", justifyContent: "center" },
  pillText: { ...text.sm, color: color.mutedForeground, flexShrink: 1 },
  toDot: { fontSize: 10, color: color.mutedForeground },
  end: { flexDirection: "row", alignItems: "center", gap: 2, marginLeft: "auto", flexShrink: 1, minWidth: 0 },
  status: { ...text.xs, color: color.mutedForeground, flexShrink: 1, paddingHorizontal: 4 },
  send: { width: size.controlSm, height: size.controlSm, borderRadius: size.controlSm / 2, backgroundColor: color.primary, alignItems: "center", justifyContent: "center" },
  run: { height: size.controlSm, borderRadius: size.controlSm / 2, paddingHorizontal: 12, backgroundColor: color.primary, alignItems: "center", justifyContent: "center" },
  runText: { ...text.sm, fontWeight: "500", color: color.primaryFg },
  stop: { width: 10, height: 10, borderRadius: 2, backgroundColor: color.primaryFg },
  waits: { ...text.xs, color: color.mutedForeground, paddingHorizontal: 8, marginTop: -4 },
  tiles: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end", gap: 8, paddingHorizontal: 4, paddingTop: 4, paddingBottom: 6 },
  thumb: { width: size.thumb, height: size.thumb, borderRadius: size.radiusSurface, overflow: "hidden", backgroundColor: color.muted },
  ring: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: size.radiusSurface, borderWidth: 1, borderColor: color.border },
  centred: { alignItems: "center", justifyContent: "center" },
  fileCard: { width: size.card, maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 8, padding: 6, paddingRight: 28, borderRadius: size.radiusSurface, borderWidth: 1, borderColor: color.border },
  iconBox: { width: size.controlLg, height: size.controlLg, borderRadius: size.radiusIconButton, backgroundColor: color.background, alignItems: "center", justifyContent: "center" },
  cardTitle: { ...text.sm, color: color.foreground },
  cardDetail: { ...text.xs, color: color.mutedForeground },
  remove: { position: "absolute", top: 6, right: 6, width: size.iconMd, height: size.iconMd, borderRadius: size.iconMd / 2, backgroundColor: color.foreground, alignItems: "center", justifyContent: "center", zIndex: 1 },
  viewer: { flex: 1, backgroundColor: "#000" },
  done: { alignSelf: "flex-end", padding: 16 },
  doneText: { ...text.base, fontWeight: "600", color: color.primary },
  going: { alignSelf: "flex-end", maxWidth: "85%", gap: 4, borderRadius: 16, backgroundColor: color.bubble, padding: 12 },
  goingText: { ...text.base, color: color.chat },
  actions: { flexDirection: "row", gap: 16 },
  link: { ...text.sm, color: color.link },
  muted: { ...text.sm, color: color.mutedForeground },
  error: { ...text.sm, color: color.destructive },
});
