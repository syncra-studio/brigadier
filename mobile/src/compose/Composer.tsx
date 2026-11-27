// The composer under a session's thread, as the desktop's session/composer.tsx wires it [D183, D188, D363]: Send, or
// while a turn runs Queue (hold Send to Steer, where the agent can); Stop and Resume; the queue card; messages on their
// way with Try again and Discard, nothing sent again by itself; this phone's own draft kept on the Mac; `/` and `@`.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useHeaderHeight } from "@react-navigation/elements";
import type { Chip as PanelChip } from "../../vendor/brigadier-shared/chips";
import { type Chip, type Draft, EMPTY_DRAFT, isEmpty, plainText, sendMode } from "../../vendor/brigadier-shared/draft";
import type { ModelRow } from "../../vendor/brigadier-shared/session/model";
import { inThread, type QueuedMessage, queuedOf, type RustQueued } from "../../vendor/brigadier-shared/session/queued";
import { failure } from "../../vendor/brigadier-shared/session/run";
import { chipArgs, draftArgs, sendOp, sends } from "../../vendor/brigadier-shared/session/sent";
import type { Going } from "../../vendor/brigadier-shared/session/uncertain";
import { request, streamNow } from "../link";
import { lists, thread } from "../mac/mac";
import { color, text } from "../theme";
import { ModelPill } from "./Model";
import { QueueCard } from "./Queue";
import { forMac, newId, withChips } from "./state";

/** A session's row with what the composer needs from Rust, as the desktop's ComposerRow. */
type ComposerRow = ModelRow & {
  /** `editing`: the message pulled back to edit, kept by Rust; any device's. */
  queue?: { paused: boolean; items: RustQueued[]; editing?: { id: string; text: string; parts?: Draft; slot: number; to?: string; shell?: string } | null; running?: string[] } | null;
  steer?: boolean;
  /** The last turn was the user's Stop: Resume carries it on [D373]. */
  resumable?: boolean;
  holding?: boolean;
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

/** The draft for Rust, which builds the agent's words from its parts; none for words alone (the desktop's files.tsx `payload`). */
const payload = (parts: Draft["parts"]) => (parts.some((part) => typeof part !== "string") ? JSON.stringify({ parts, attachmentIds: [] }) : undefined);
/** The message's parts with the chips' words after them, as in the text. */
const body = (parts: Draft["parts"], sent: readonly PanelChip[]) => payload(sent.length === 0 ? parts : [...parts, `${isEmpty({ parts, attachmentIds: [] }) ? "" : "\n\n"}${withChips("", sent)}`]);

/** A `/` list row: the agent's command, or Brigadier's own tool, as the desktop's commands.tsx and tools.tsx list them. */
type Command = { id: string; kind: "command" | "tool" | "skill" | "mcp" | "prompt"; label: string; description?: string; instant: boolean };
const TOOLS: Command[] = [
  ["computer", "Use the apps on your Mac"],
  ["browser", "Open pages, click and type in Brigadier's browser"],
  ["mockup", "Draw 3 looks to pick from before building"],
  ["image", "Make or edit a picture"],
  ["research", "Search and read the web, with sources"],
  ["workers", "Split the job across workers in parallel"],
].map(([id, line]): Command => ({ id, kind: "tool", label: `/${id}`, description: line, instant: false }));
type Mention = { id: string; type: string; label: string; name?: string; detail?: string; hint?: string };

export function Composer({ id }: { id: string }) {
  const mac = forMac();
  const header = useHeaderHeight();
  const { run, unsaved, drafts, sends: sending, uncertain, chips: waitingChips, edits } = mac;
  const row = useSyncExternalStore(lists.subscribe, () => lists.get().rows.find((each) => each.id === id)) as ComposerRow | undefined;
  const conn = useSyncExternalStore(lists.subscribe, () => (lists.get().ready ? streamNow() : -1));
  const connected = conn >= 0;
  const session = useSyncExternalStore(thread.subscribe, () => (thread.get()?.id === id ? thread.get()?.session : null) ?? null);
  const going = useSyncExternalStore(uncertain.subscribe, () => uncertain.goingOf(id));
  const panel = useSyncExternalStore(waitingChips.chips.subscribe, () => waitingChips.of(id));

  // The field: its words, and the chips put in them, each shown as its label.
  const [initial] = useState(() => drafts.draftOf(id) ?? EMPTY_DRAFT);
  const [words, setWords] = useState(() => plainText(initial.parts));
  const named$ = useRef<Named[]>(initial.parts.filter(named));
  const words$ = useRef(words);
  const cursor = useRef(words.length);
  const [menu, setMenu] = useState<{ kind: "/" | "@"; query: string; from: number } | null>(null);
  const partsNow = () => partsOf(words$.current, named$.current);
  const empty = isEmpty({ parts: partsOf(words, named$.current), attachmentIds: [] });
  /** Puts `parts` in the field; `save`, kept as the draft too, as a change typed is. */
  const setField = (parts: Draft["parts"], save = true) => {
    words$.current = plainText(parts);
    named$.current = parts.filter(named);
    cursor.current = words$.current.length;
    setWords(words$.current);
    setMenu(null);
    if (save) drafts.keepDraft(run, id, { parts, attachmentIds: [] });
  };

  const [ops, setOps] = useState<Op[]>([]);
  const [error, setError] = useState<string | null>(() => drafts.givenError(id));
  const [stopping, setStopping] = useState(false);
  const editing = { get: () => edits.get(id) ?? null, set: (pulled: Pulled) => void (pulled ? edits.set(id, pulled) : edits.delete(id)) };

  // A message pulled back to edit that this phone can't prove is its own (another device's, or from before a relaunch)
  // is never claimed: the queue card offers Put back instead.
  const kept = row?.queue?.editing;
  const foreign = kept && edits.get(id)?.qid !== kept.id ? kept : null;
  // After a restart the draft is Rust's alone: it comes back unless something was typed first.
  useEffect(() => {
    void drafts.loadDraft(run, id).then((saved) => {
      if (!saved || !isEmpty({ parts: partsNow(), attachmentIds: [] })) return;
      setField(saved.parts, false);
    });
  }, []);
  // A message Rust gave back goes above what's typed since, never over it [D363].
  useEffect(() =>
    drafts.onGiven(id, (back) => {
      const typed = partsNow();
      const parts = isEmpty({ parts: typed, attachmentIds: [] }) ? back.parts : [...back.parts, "\n\n", ...typed];
      setField(parts, false);
      if (back.error) setError(back.error);
      return { parts, attachmentIds: [] };
    }),
  );
  // Each connection: what waits above the field, read again; messages Rust may not hold handed to it, a Delete told instead (the desktop's sent.tsx `useHanding`).
  useEffect(() => {
    if (!connected) return;
    waitingChips.load(id);
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
    const sub: Sub = { draft: { parts, attachmentIds: [] }, rev: drafts.revOf(id), chips: sent };
    send(editing.get(), sub);
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
    if (isEmpty({ parts, attachmentIds: [] }) && sent.length === 0) {
      // Held with nothing typed, it steers the first queued message [D183].
      if (other && running && canSteer && items[0]?.state === "queued" && !items[0].shell) steerQueued(items[0].id);
      return;
    }
    // The chips go after the words, and leave once it's sent or queued; a failed send keeps them in its message.
    const message = withChips(plainText(parts), sent);
    // The Mac reads words that start with `--` as a flag, so it refuses them.
    if (message.startsWith("--")) return setError("A message can't start with --");
    const draft = body(parts, sent);
    // Queue or Steer is the Mac's setting; the phone takes its default, Queue [D188].
    const mode = chosen ?? sendMode(running || commands, "queue", other, canSteer && running);
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
    const parts = partsNow();
    named$.current = parts.filter(named);
    drafts.keepDraft(run, id, { parts, attachmentIds: [] });
    const pulled = editing.get();
    if (pulled && isEmpty({ parts, attachmentIds: [] })) {
      editing.set(null);
      act({ kind: "add", qid: pulled.qid, text: pulled.text, slot: pulled.slot }, ["restore"]);
    }
  };
  // The `/` or `@` the caret is just after, at a word's start, and what's typed after it.
  const lookAt = (at: number) => {
    cursor.current = at;
    const hit = /(^|\s)([@/])([^\s@/]*)$/.exec(words$.current.slice(0, at));
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
    drafts.keepDraft(run, id, { parts: partsNow(), attachmentIds: [] });
  };
  const runCommand = (command: Command) => {
    replace("");
    void run(["command", id, command.label.slice(1)]).then((reply) => !reply.ok && setError(String(reply.error ?? `Couldn't run ${command.label}`)));
  };

  // Nothing to send: no words, and nothing waiting above the field.
  const blank = empty && panel.length === 0;
  const state = busy && connected && blank ? "stop" : !running && blank && resumable ? "resume" : "send";
  const press = () => (state === "stop" ? stop() : state === "resume" ? resume() : submit(false));
  // Always set, so the release after a long press isn't also a tap (a steer turns the button into Stop meanwhile).
  const hold = () => (state === "send" && running && canSteer ? submit(true) : press());
  const verb = running && !blank ? "Queue" : "Send message";
  const shownSends = sends(going).filter((each) => !delivered.has(each.cid));
  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={header}>
      <SafeAreaView edges={["bottom"]} style={st.composer}>
        {shownSends.map((each) => <OnItsWay key={each.cid} entry={each} id={id} />)}
        <QueueCard
          items={items}
          paused={paused}
          resuming={resuming || stopping || !connected}
          steer={canSteer && running}
          canEdit={empty}
          error={(stuck ? `Not sent: ${stuck.error}. Edit or delete it to go on.` : null) ?? (items.length > 0 ? error : null)}
          onResume={resume}
          onSteer={steerQueued}
          onRemove={(qid) => (lost(qid) ? sending.discard(run, id, lost(qid)!) : act({ kind: "remove", qid }, ["remove", qid]))}
          onEdit={edit}
          onAddAgain={(qid) => void sending.again(run, id, lost(qid)!)}
          onMove={move}
          pulled={foreign && !live.some((op) => op.qid === foreign.id) ? { text: foreign.parts ? plainText(foreign.parts.parts) : foreign.text, onPutBack: () => act({ kind: "add", qid: foreign.id, text: foreign.text, slot: foreign.slot }, ["restore"]) } : null}
        />
        {menu?.kind === "/" ? <Commands id={id} query={menu.query} fresh={running} onPick={(command) => (command.instant ? runCommand(command) : replace(`${command.label} `, { kind: "command", id: command.id, type: command.kind, label: command.label }))} /> : null}
        {menu?.kind === "@" ? <Mentions id={id} query={menu.query} onPick={(item) => replace(`${item.label} `, { kind: "mention", id: item.id, type: item.type as Extract<Named, { kind: "mention" }>["type"], label: item.label })} /> : null}
        {panel.length > 0 ? (
          <View style={st.tiles}>
            {panel.map((chip) => <Text key={chip.id} style={st.tile} numberOfLines={1}>{tileOf(chip)}</Text>)}
          </View>
        ) : null}
        <View style={st.field}>
          <TextInput
            style={st.input}
            multiline
            placeholder={connected ? "Do anything" : "Not connected"}
            placeholderTextColor={color.mutedForeground}
            onChangeText={typed}
            onSelectionChange={(event) => lookAt(event.nativeEvent.selection.end)}
            accessibilityLabel="Message"
          >
            {segments(words, named$.current).map(([part, chip], at) => <Text key={at} style={chip ? st.chip : undefined}>{part}</Text>)}
          </TextInput>
          <View style={st.bar}>
            <ModelPill id={id} row={row} connected={connected} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={state === "stop" ? "Stop" : state === "resume" ? "Resume" : verb}
              accessibilityHint={state === "send" && running && canSteer ? "Hold to steer it into the running turn" : undefined}
              disabled={!connected || (state === "send" && blank) || (state === "stop" && stopping) || (state === "resume" && resuming)}
              onPress={press}
              onLongPress={hold}
              style={({ pressed }) => [st.send, (pressed || !connected || (state === "send" && blank)) && { opacity: 0.4 }]}
            >
              <Text style={st.sendGlyph}>{state === "stop" ? "■" : state === "resume" ? "▶" : "↑"}</Text>
            </Pressable>
          </View>
        </View>
        {error && items.length === 0 ? <Text style={st.error}>{error}</Text> : null}
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

/** The field's words cut at each chip, so a chip is drawn as one. */
function segments(words: string, chips: readonly Named[]): [string, boolean][] {
  return partsOf(words, chips).map((part) => (typeof part === "string" ? [part, false] : [(part as Named).label, true]));
}

const tileOf = (chip: PanelChip) => {
  if (chip.kind === "comment") {
    const { path, start, end } = chip.comment;
    return `${path.slice(path.lastIndexOf("/") + 1)}:${start === end ? start : `${start}–${end}`}`;
  }
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return chip.chip.kind === "resolve" ? `Resolve ${plural(chip.chip.conflicts, "conflict")}` : `Fix ${chip.chip.run}`;
};

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

/** The `/` menu: Brigadier's tools first, then the agent's commands, asked again as a turn starts or ends. */
function Commands({ id, query, fresh, onPick }: { id: string; query: string; fresh: boolean; onPick: (command: Command) => void }) {
  const { run } = forMac();
  const [listed, setListed] = useState<Command[] | null>(null);
  useEffect(() => {
    let live = true;
    void run(["commands", id]).then((reply) => {
      if (!live) return;
      const list: { name: string; description?: string; kind: Command["kind"]; instant: boolean }[] = reply.ok ? (reply.commands ?? []) : [];
      // A prompt kept as Claude listed it before prompts had a kind of their own.
      const kindOf = (each: (typeof list)[number]) => (each.kind === "mcp" && each.name.startsWith("mcp__") ? "prompt" : each.kind);
      setListed(list.map((each) => ({ id: `${kindOf(each)}:${each.name}`, kind: kindOf(each), label: `/${each.name}`, description: each.description || undefined, instant: each.instant })));
    });
    return () => void (live = false);
  }, [id, fresh]);
  const want = query.toLowerCase();
  const order = { command: 0, tool: 1, skill: 2, mcp: 3, prompt: 4 };
  const rank = (each: Command) => (each.label.slice(1).toLowerCase().startsWith(want) ? 0 : each.label.toLowerCase().includes(want) ? 1 : 2);
  const shown = [...TOOLS, ...(listed ?? [])].filter((each) => rank(each) < 2).sort((a, b) => order[a.kind] - order[b.kind] || rank(a) - rank(b));
  return (
    <Menu loading={listed === null} empty="No commands">
      {shown.map((each) => <MenuRow key={each.id} title={each.label} detail={each.description} onPress={() => onPick(each)} />)}
    </Menu>
  );
}

/** The `@` menu: the Mac's chats, workers, tabs, notes and plugins for the query; only the last asked shows [D127]. */
function Mentions({ id, query, onPick }: { id: string; query: string; onPick: (item: Mention) => void }) {
  const [found, setFound] = useState<{ title: string | null; items: Mention[] }[] | null>(null);
  const asked = useRef(query);
  useEffect(() => {
    asked.current = query;
    try {
      request({ op: "mention", owner: id, q: query }, (reply) => {
        if (reply.ok && reply.query === asked.current) setFound(reply.groups);
      });
    } catch {
      // Not connected: the menu stays as it was.
    }
  }, [query]);
  return (
    <Menu loading={found === null} empty="No results">
      {(found ?? []).flatMap((group) =>
        // Message directly is a worker's own message, not this step's.
        group.items.filter((item) => !["direct", "file", "folder"].includes(item.type)).map((item) => <MenuRow key={`${group.title}:${item.id}`} title={item.name ?? item.label} detail={item.detail ?? item.hint} onPress={() => onPick(item)} />),
      )}
    </Menu>
  );
}

function Menu({ loading, empty, children }: { loading: boolean; empty: string; children: React.ReactNode[] }) {
  return (
    <ScrollView style={st.menu} keyboardShouldPersistTaps="always">
      {children.length > 0 ? children : <Text style={[st.muted, { padding: 12 }]}>{loading ? "Loading…" : empty}</Text>}
    </ScrollView>
  );
}

const MenuRow = ({ title, detail, onPress }: { title: string; detail?: string; onPress: () => void }) => (
  <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [st.menuRow, pressed && { backgroundColor: color.fill }]}>
    <Text style={st.menuTitle} numberOfLines={1}>{title}</Text>
    {detail ? <Text style={st.muted} numberOfLines={1}>{detail}</Text> : null}
  </Pressable>
);

const st = StyleSheet.create({
  composer: { gap: 8, paddingHorizontal: 12, paddingTop: 8, borderTopWidth: 1, borderTopColor: color.border, backgroundColor: color.background },
  field: { borderRadius: 20, borderWidth: 1, borderColor: color.border, backgroundColor: color.codeSurface, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8, gap: 8 },
  input: { ...text.base, color: color.foreground, maxHeight: 150, padding: 0 },
  chip: { color: color.link },
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  send: { marginLeft: "auto", width: 32, height: 32, borderRadius: 16, backgroundColor: color.primary, alignItems: "center", justifyContent: "center" },
  sendGlyph: { fontSize: 16, fontWeight: "700", color: color.primaryFg },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  tile: { ...text.sm, color: color.foreground, backgroundColor: color.muted, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4, maxWidth: 220 },
  going: { alignSelf: "flex-end", maxWidth: "85%", gap: 4, borderRadius: 16, backgroundColor: color.bubble, padding: 12 },
  goingText: { ...text.base, color: color.chat },
  actions: { flexDirection: "row", gap: 16 },
  link: { ...text.sm, color: color.link },
  muted: { ...text.sm, color: color.mutedForeground },
  error: { ...text.sm, color: color.destructive },
  menu: { maxHeight: 240, borderRadius: 16, backgroundColor: color.muted },
  menuRow: { paddingHorizontal: 12, paddingVertical: 10, gap: 2 },
  menuTitle: { ...text.base, color: color.foreground },
});
