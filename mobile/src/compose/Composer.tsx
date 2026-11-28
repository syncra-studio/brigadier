// The composer under a session's thread, as the desktop's session/composer.tsx and composer/composer.tsx lay it out
// and wire it [D183, D188, D363, D2108]: the rail (the night, Before you go, the queue) tucked under one card, which holds
// the tiles, the field and the footer (+, the level pill, Overnight, To ‹worker›, then status, the model and Send). Send,
// or while a turn runs Queue (hold Send to Steer, where the agent can); Stop and Resume; messages on their way with Try
// again and Discard, nothing sent again by itself; this phone's own draft kept on the Mac; `/`, `@` and +; `!` commands,
// Run in background, the level pill, Overnight and /new, each signed with Face ID [D57].
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { KeyboardAvoidingView, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useHeaderHeight } from "@react-navigation/elements";
import { type Draft, EMPTY_DRAFT, isEmpty, plainText } from "../../../app/shared/draft";
import { inThread, type QueuedMessage, queuedOf } from "../../../app/shared/session/queued";
import { sends } from "../../../app/shared/session/sent";
import type { Frame } from "../../../app/shared/client";
import { COMPACTION } from "../../../app/shared/words";
import { Confirm } from "../act/Confirm";
import { streamNow } from "../link";
import { lists, thread } from "../mac/mac";
import { color, spacing, opacity, touch } from "../theme";
import { LevelPill } from "../powers/Level";
import { NightReady, nightPlaceholder, OvernightPill, OvernightStrip, StartNight, useNight } from "../powers/Overnight";
import { backgroundPower, type Power, refusal, shellOf } from "../powers/powers";
import { ImageSigns } from "../powers/View";
import { composerSample } from "../mac/sample";
import { ArrowUp, PlayTriangle, Plus, Stop } from "../../../app/ui/src/icons";
import { WorkerGlyph } from "../../../app/ui/src/icons/worker-glyphs";
import { Shimmer } from "./motion";
import { type Command, Commands, Mentions, NEW_SESSION, OVERNIGHT, PlusMenu, useCommands } from "./Menus";
import { ModelPill } from "./Model";
import { Pill, PillDivider } from "./Pill";
import { QueueCard } from "./Queue";
import { ChipTile, type ComposerRow, Field, Link, type Named, named, OnItsWay, type Op, partsOf, type Pulled, st, Tile, tilesOf, type To, useLatest, Viewer } from "./parts";
import { sendActions } from "./send";
import { type Attachment, forMac, type Picked } from "./state";

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
    fileStore.restore(id, tilesOf(initial));
    fileStore.load(id);
    void drafts.loadDraft(run, id).then((saved) => {
      if (!saved || !isEmpty({ parts: partsNow(), attachmentIds: [] })) return;
      setField(saved.parts, false);
      fileStore.restore(id, tilesOf(saved));
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
      fileStore.restore(id, tilesOf(back));
      if (back.error) setError(back.error);
      return { parts, attachmentIds: [...new Set([...tilesOf(back), ...tilesNow()])] };
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

  /** Why Send waits now, in the desktop's words; none when it can go. */
  const waitsFor = () => {
    const now = fileStore.of(id);
    const tiles = now.tiles.flatMap((each) => now.all.get(each) ?? []);
    if (tiles.some((each) => each.state === "uploading")) return "Files uploading…";
    // Kept in the draft, not read from Rust's folder yet.
    if (tiles.length < now.tiles.length) return "Files loading…";
    if (tiles.some((each) => each.state === "ready" && each.mime.startsWith("image/")) && !mac.models.takesImages(((toRow as typeof row) ?? row)?.backend, ((toRow as typeof row) ?? row)?.model)) return "This model does not support image inputs. Try a different model";
    return undefined;
  };
  const { act, steerQueued, edit, submit, toAgain, toEdit, toDiscard, stop, resume, move } = sendActions({ id, mac, row, connected, worker, to, toWorker, toSending, toGone, inProject, running, canSteer, commands, paused, items, editing, lost, textOf, readyNow, tilesNow, partsNow, setField, waitsFor, words$, named$, setOps, setError, setPowerError, setPower, setToSending, setTo, setStopping });
  const resuming = live.some((op) => op.kind === "resume");
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
  const shownError = useLatest([powerError, night.error, items.length === 0 ? error : null]);
  const placeholder = shell ? "Run a command" : toWorker ? `Message ${toWorker.name}` : (nightPlaceholder(night.now, busy, asked) ?? "Do anything");
  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={header}>
      <SafeAreaView edges={{ bottom: "maximum" }} style={st.column}>
        {shownSends.map((each) => <OnItsWay key={each.cid} entry={each} id={id} />)}
        {toLost.map((lost) => (
          <View key={lost.cid} style={st.going}>
            <Text style={st.goingText} numberOfLines={3}>{lost.text}</Text>
            <Text style={st.error}>{lost.refused ? `Not sent to ${lost.target.name}: ${lost.error}` : `May have been sent to ${lost.target.name} · ${lost.error}`}</Text>
            {lost.queued || lost.refused ? null : <Text style={st.muted}>If it went, it still reaches {lost.target.name}</Text>}
            <View style={st.actions}>
              {lost.refused ? <Link title="Edit" disabled={!empty} onPress={() => toEdit(lost)} /> : <Link title="Try again" disabled={lost.busy} onPress={() => toAgain(lost)} />}
              <Link title={lost.queued || lost.refused ? "Discard" : "Stop showing"} disabled={lost.busy} onPress={() => toDiscard(lost)} />
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
                  hitSlop={(touch - spacing.controlSm) / 2}
                  style={({ pressed }) => [st.plus, (pressed || plus) && { backgroundColor: color.fill }]}
                >
                  <Plus className="size-icon-md text-primary" />
                </Pressable>
                {!worker ? <LevelPill id={id} row={row} connected={connected} /> : null}
                {!worker ? <OvernightPill night={night} connected={connected} /> : null}
                {toWorker ? (
                  <>
                    <PillDivider />
                    <Pill label={`To ${toWorker.name}: send to this session instead`} selected disabled={toSending} onPress={() => setTo(null)} style={{ maxWidth: 192 }}>
                      <WorkerGlyph id={toWorker.id} />
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
                hitSlop={(touch - spacing.controlSm) / 2}
                style={({ pressed }) => [runs ? st.run : st.send, off ? { opacity: opacity.disabled } : pressed && { opacity: 0.8 }]}
              >
                {state === "stop" ? <Stop className="size-icon-sm text-primary-fg" /> : state === "resume" ? <PlayTriangle className="size-icon-md text-primary-fg" /> : runs ? <Text style={st.runText}>Run</Text> : <ArrowUp className="size-icon-md text-primary-fg" />}
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
