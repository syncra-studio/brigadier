// New chat in a project, as the desktop's home/start.ts starts one [D30, D161, C65]: this iPhone's own Home draft of
// the project (`@home:<project>`, kept by Rust), the project's last model, and the start signed with Face ID. The Mac
// picks the worktree and the project's level. Refused, Rust gives the words back into this draft; nothing is sent again
// by itself.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActionSheetIOS, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useHeaderHeight } from "@react-navigation/elements";
import { type Chip, type Draft, EMPTY_DRAFT, plainText } from "../../vendor/brigadier-shared/draft";
import { asGroups, type ModelChoice, type ModelGroup, type ModelRow } from "../../vendor/brigadier-shared/session/model";
import { failure } from "../../vendor/brigadier-shared/session/run";
import { flagOf, type Going, UNCONFIRMED } from "../../vendor/brigadier-shared/session/uncertain";
import { Confirm } from "../act/Confirm";
import { Button } from "../Button";
import { streamNow } from "../link";
import { effortLabel } from "../compose/Model";
import { forMac, newId } from "../compose/state";
import { lists } from "../mac/mac";
import { color, text } from "../theme";

/**
 * A kept start as the phone sends it: one the Mac's book brought back is its stored command (`--home` or `--slot` in
 * it, its draft not), so those go and its draft comes back; its session and command ids stay.
 */
function phoneOp({ op, draft, rev }: Going): string[] {
  const out = op.slice(0, 2);
  for (let i = 2; i < op.length; i++) {
    if (op[i] === "--text") out.push(op[i]!, op[++i] ?? "");
    else if (["--home", "--slot", "--draft", "--draft-rev"].includes(op[i]!)) i++;
    else out.push(op[i]!);
  }
  return [...out, "--draft", JSON.stringify({ parts: draft.parts, attachmentIds: draft.attachmentIds }), ...(typeof rev === "number" ? ["--draft-rev", String(rev)] : [])];
}

type Files = { chips: Extract<Chip, { attachmentId: string }>[]; ids: string[] };
const NO_FILES: Files = { chips: [], ids: [] };
const filesOf = (draft: Pick<Draft, "parts" | "attachmentIds"> | undefined): Files => ({
  chips: (draft?.parts ?? []).filter((part): part is Files["chips"][number] => typeof part !== "string" && "attachmentId" in part),
  ids: draft?.attachmentIds ?? [],
});

/** A new session's id, made here as the desktop makes it, so the start can be asked again under it. */
export const sessionId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function Start({ project, name, onStarted }: { project: string; name: string; onStarted: (id: string, title: string) => void }) {
  const { run, drafts, unsaved, uncertain } = forMac();
  const key = `@home:${project}`;
  const header = useHeaderHeight();
  const conn = useSyncExternalStore(lists.subscribe, () => (lists.get().ready ? streamNow() : -1));
  const connected = conn >= 0;
  const [words, setWords] = useState(() => plainText(drafts.draftOf(key)?.parts ?? []));
  const words$ = useRef(words);
  // What the field holds beyond its words, kept through edits and sent with it (`--parts`): a draft's files and its
  // pasted or image chips. A mention reads as its words: the phone's start takes none of a file's.
  const [files, setFiles] = useState(() => filesOf(drafts.draftOf(key)));
  const files$ = useRef(files);
  const put = (next: string, kept = files$.current) => {
    words$.current = next;
    files$.current = kept;
    setWords(next);
    setFiles(kept);
  };
  const draftNow = (): Draft => ({ parts: [...(words$.current ? [words$.current] : []), ...files$.current.chips], attachmentIds: files$.current.ids });
  // A start refused while New chat was closed says why once it opens.
  const [error, setError] = useState<string | null>(() => drafts.givenError(key));
  // The start being signed, as it goes; `fresh`: from the field just now, so a cancel puts its words back there.
  const [asking, setAsking] = useState<{ entry: Going; fresh: boolean } | null>(null);
  // Starts on their way or unsettled, kept per Mac under this draft's key as the desktop keeps them (uncertain.ts),
  // Rust's book's ones coming in with the draft's read: each with Try again (the same command, the same ids) and
  // Discard, the field free meanwhile [C65].
  const going = useSyncExternalStore(uncertain.subscribe, () => uncertain.goingOf(key));
  const held = going.filter((each) => each.kind === "start" && !each.removing && each.cid !== asking?.entry.cid);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // One in its session's log that its agent didn't confirm or refused: why, and Open the session.
  const [landed, setLanded] = useState<{ id: string; title: string; error: string } | null>(null);

  useEffect(() => {
    void drafts.loadDraft(run, key).then((saved) => saved && !words$.current.trim() && put(plainText(saved.parts), filesOf(saved)));
  }, []);
  // A read or save refused while away goes now, as the session composer does.
  useEffect(() => {
    if (connected && unsaved.delete(key)) drafts.resyncDraft(run, key);
  }, [conn]);
  // Given back, its words go above what's typed since, never over it [D363].
  useEffect(() =>
    drafts.onGiven(key, (back) => {
      const typed = words$.current;
      const next = typed.trim() ? `${plainText(back.parts)}\n\n${typed}` : plainText(back.parts);
      const theirs = filesOf(back);
      put(next, { chips: [...theirs.chips, ...files$.current.chips], ids: [...new Set([...theirs.ids, ...files$.current.ids])] });
      if (back.error) setError(back.error);
      return draftNow();
    }),
  );
  const typed = (next: string, kept = files$.current) => {
    put(next, kept);
    drafts.keepDraft(run, key, draftNow());
  };

  // The model: the one picked here, else the project's last session's, else the first an agent offers; only one the
  // list still has counts, once it's read [D129].
  const [groups, setGroups] = useState<ModelGroup[] | null>(null);
  const [picked, setPicked] = useState<ModelChoice | null>(null);
  useEffect(() => {
    if (connected) void run(["models", "--project", project]).then((reply) => reply.ok && setGroups(asGroups(reply.groups)));
  }, [connected]);
  const rows = useSyncExternalStore(lists.subscribe, () => lists.get().rows) as ModelRow[];
  const last = rows.filter((row) => row.project === project && row.model).sort((a, b) => b.sent - a.sent)[0];
  const offered = (groups ?? []).filter((group) => !group.unavailable).flatMap((group) => group.models.filter((model) => !model.legacy).map((model) => ({ group, model })));
  const has = (choice: ModelChoice | null | undefined): choice is ModelChoice => !!choice && (!groups || offered.some(({ group, model }) => group.provider === choice.provider && model.id === choice.model));
  const lastChoice = last && { provider: last.backend, model: last.model!, effort: last.effort ?? null, fast: last.fast === true };
  const first = offered[0] && { provider: offered[0].group.provider, model: offered[0].model.id, effort: offered[0].model.defaultEffort ?? null };
  const choice = [picked, lastChoice, first].find(has) ?? null;
  const shown = (each: ModelChoice) => {
    const model = offered.find(({ group, model }) => group.provider === each.provider && model.id === each.model)?.model;
    return [model?.name ?? each.model, each.fast ? "⚡" : null, each.effort ? effortLabel(each.effort) : null].filter(Boolean).join(" ");
  };
  const pick = () =>
    ActionSheetIOS.showActionSheetWithOptions({ title: "Model", options: [...offered.map(({ group, model }) => `${group.short ?? group.label} · ${model.name}`), "Cancel"], cancelButtonIndex: offered.length }, (at) => {
      const was = offered[at];
      if (was) setPicked({ provider: was.group.provider, model: was.model.id, effort: was.model.defaultEffort ?? null });
    });

  const start = () => {
    const message = words$.current.trim();
    const draft = draftNow();
    const withFiles = draft.attachmentIds.length > 0 || files$.current.chips.length > 0;
    if ((!message && !withFiles) || !choice) return;
    // The Mac reads words that start with `--` as a flag, so it refuses them.
    if (message.startsWith("--")) return setError("A message can't start with --");
    setError(null);
    const rev = drafts.revOf(key);
    const cid = newId();
    const op = ["start", sessionId(), "--project", project, "--cid", cid, "--draft", JSON.stringify(draft), "--draft-rev", String(rev), "--text", message, ...(withFiles ? ["--parts", JSON.stringify(draft)] : []), "--backend", choice.provider, "--model", choice.model, ...(choice.effort ? ["--effort", choice.effort] : []), ...(choice.fast ? ["--fast"] : [])];
    // Kept before the field empties, so a give-back by any way takes this copy once, and nothing typed since.
    const entry = uncertain.keepGoing(key, { cid, kind: "start", op, draft, rev, at: Date.now() });
    put("", NO_FILES);
    drafts.keepDraft(run, key, EMPTY_DRAFT);
    setAsking({ entry, fresh: true });
  };
  const textOf = (op: readonly string[]) => flagOf(op, "--text") ?? "";
  const modelOf = (op: readonly string[]) => shown({ provider: flagOf(op, "--backend") ?? "", model: flagOf(op, "--model") ?? "", effort: flagOf(op, "--effort") ?? null, fast: op.includes("--fast") });
  const titleOf = (op: readonly string[]) => textOf(op).split("\n")[0]!.slice(0, 80);
  /** The start's reply, read by its outcome as the desktop's `land`, never by the session merely existing. */
  const land = ({ entry, fresh }: { entry: Going; fresh: boolean }, reply: Record<string, any> | null) => {
    setAsking(null);
    const { cid, op } = entry;
    // Not sent (Face ID cancelled), or refused before it ran (no Face ID, not from the phone, turned off).
    const ran = reply && (reply.ok || reply.given_back || reply.went || reply.result !== undefined || "logged" in reply || reply.unsettled || reply.session || reply.left || reply.error === "closed");
    if (!ran) {
      if (reply) setError(failure(reply));
      // Just from the field: its words go back there, above what's typed since.
      if (fresh) drafts.takeBack(run, key, { cid, ...entry.draft });
      else if (reply) uncertain.markGoing(key, cid, { stuck: failure(reply) });
      return;
    }
    setError(null);
    if (reply.given_back) {
      // Its session is gone, Rust says: its words are this draft's again, above what's typed, once whichever way they come.
      if (reply.again || !Array.isArray(reply.parts)) {
        uncertain.forget(key, cid);
        drafts.resyncDraft(run, key);
      } else drafts.takeBack(run, key, { cid: reply.cid ?? cid, parts: reply.parts, attachmentIds: reply.attachmentIds ?? [], error: failure(reply), typed: reply.typed });
      // A Discard's give-back is no refusal: nothing to say then.
      return setError(reply.message || reply.error ? failure(reply) : null);
    }
    const delivered = reply.result === "delivered" || (reply.ok && reply.result === undefined) || reply.went || reply.result === "went" || reply.result === "settled";
    // In its session's log, its agent not confirming it, or refusing it: the session shows how it went.
    const logged = reply.result === "logged" || reply.logged === true;
    if (delivered || logged) uncertain.forget(key, cid);
    if (delivered) return onStarted(op[1]!, titleOf(op));
    if (logged) return setLanded({ id: op[1]!, title: titleOf(op), error: reply.result === "logged" ? String(reply.error ?? "It reached the log, but not the agent.") : String(reply.why ?? failure(reply)) });
    const why = reply.error === "closed" ? "The connection to your Mac ended before it answered, so it may have started." : String(reply.why ?? failure(reply));
    uncertain.markGoing(key, cid, { stuck: why, booked: entry.booked || reply.unsettled === true || !!reply.session, reached: reply.error !== "closed" || entry.reached, left: reply.left === true });
  };
  /** Discard: Rust takes the start back (`drop`), its words into this draft; one it never had comes back from here. */
  const discard = (entry: Going) => {
    setBusy((now) => new Set(now).add(entry.cid));
    void run(["draft", key, "drop", entry.cid]).then((reply) => {
      setBusy((now) => new Set([...now].filter((each) => each !== entry.cid)));
      if (reply.given_back || reply.went) return land({ entry, fresh: false }, reply);
      // None to give back: its words come from here only if its session isn't on the Mac (it never landed); one that
      // is went, settled already.
      if (reply.ok && lists.get().rows.some((row) => row.id === entry.op[1])) return uncertain.forget(key, entry.cid);
      if (reply.ok) return drafts.takeBack(run, key, { cid: entry.cid, ...entry.draft });
      uncertain.markGoing(key, entry.cid, { stuck: `Couldn't discard it: ${failure(reply)}` });
    });
  };

  const ready = connected && !!choice && (words.trim() !== "" || files.ids.length + files.chips.length > 0);
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: color.background }} behavior="padding" keyboardVerticalOffset={header}>
      <SafeAreaView edges={["bottom"]} style={st.page}>
        <Text style={st.muted}>New chat in {name}</Text>
        {files.ids.length + files.chips.length > 0 && (
          <Text style={st.muted}>
            {(() => {
              const n = new Set([...files.ids, ...files.chips.map((chip) => ("attachmentId" in chip ? chip.attachmentId : ""))]).size;
              return n === 1 ? "1 file goes with it · " : `${n} files go with it · `;
            })()}
            <Text style={{ color: color.link }} accessibilityRole="button" onPress={() => typed(words$.current, NO_FILES)}>Remove</Text>
          </Text>
        )}
        <View style={st.field}>
          <TextInput style={st.input} multiline autoFocus value={words} onChangeText={typed} placeholder={connected ? "Do anything" : "Not connected"} placeholderTextColor={color.mutedForeground} accessibilityLabel="Message" />
          <View style={st.bar}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Model: ${choice ? shown(choice) : "none"}`} disabled={offered.length === 0} onPress={pick} style={({ pressed }) => [st.pill, pressed && { opacity: 0.6 }]}>
              <Text style={st.pillText} numberOfLines={1}>{choice ? shown(choice) : groups ? "No model available" : "Loading models…"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Start" disabled={!ready} onPress={start} style={({ pressed }) => [st.send, (pressed || !ready) && { opacity: 0.4 }]}>
              <Text style={st.sendGlyph}>↑</Text>
            </Pressable>
          </View>
        </View>
        {error && <Text style={st.error}>{error}</Text>}
        {landed && (
          <View style={st.held}>
            <Text style={st.pillText} numberOfLines={2}>{landed.title}</Text>
            <Text style={st.error}>{landed.error}</Text>
            <Button title="Open the session" secondary onPress={() => onStarted(landed.id, landed.title)} />
          </View>
        )}
        {held.map((entry) => (
          <View key={entry.cid} style={st.held}>
            <Text style={st.pillText} numberOfLines={2}>{textOf(entry.op) || plainText(entry.draft.parts)}</Text>
            {/* None held here is on its way: one kept with no answer (a relaunch mid-way) couldn't be confirmed. */}
            <Text style={st.error}>{entry.stuck ?? UNCONFIRMED}</Text>
            {!entry.left && <Button title="Try again" secondary disabled={busy.has(entry.cid) || !connected || !!asking} onPress={() => setAsking({ entry: { ...entry, op: phoneOp(entry) }, fresh: false })} />}
            <Button title="Discard" secondary disabled={busy.has(entry.cid) || !connected || !!asking} onPress={() => discard(entry)} />
          </View>
        ))}
      </SafeAreaView>
      {asking && (
        <Confirm
          title="Start this chat on your Mac?"
          body={`In ${name}, on ${modelOf(asking.entry.op)}.`}
          shown={textOf(asking.entry.op)}
          args={asking.entry.op}
          onDone={(reply) => land(asking, reply)}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  page: { flex: 1, padding: 12, gap: 8 },
  field: { flex: 1, borderRadius: 20, borderWidth: 1, borderColor: color.border, backgroundColor: color.codeSurface, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8, gap: 8 },
  input: { ...text.base, flex: 1, color: color.foreground, padding: 0, textAlignVertical: "top" },
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  pill: { borderRadius: 999, backgroundColor: color.fill, paddingHorizontal: 12, paddingVertical: 6, maxWidth: 260 },
  pillText: { ...text.sm, color: color.foreground },
  send: { width: 32, height: 32, borderRadius: 16, backgroundColor: color.primary, alignItems: "center", justifyContent: "center" },
  sendGlyph: { fontSize: 16, fontWeight: "700", color: color.primaryFg },
  muted: { ...text.sm, color: color.mutedForeground },
  error: { ...text.sm, color: color.destructive },
  held: { gap: 8, borderRadius: 12, backgroundColor: color.fill, padding: 12 },
});
