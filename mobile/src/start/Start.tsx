// New chat in a project, as the desktop's home/start.ts starts one [D30, D161, C65]: this iPhone's own Home draft of
// the project (`@home:<project>`, kept by Rust), the project's last model, and the start signed with Face ID. The Mac
// picks the worktree and the project's level. Refused, Rust gives the words back into this draft; nothing is sent again
// by itself.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActionSheetIOS, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useHeaderHeight } from "@react-navigation/elements";
import { EMPTY_DRAFT, plainText } from "../../vendor/brigadier-shared/draft";
import { asGroups, type ModelChoice, type ModelGroup, type ModelRow } from "../../vendor/brigadier-shared/session/model";
import { failure } from "../../vendor/brigadier-shared/session/run";
import { Confirm } from "../act/Confirm";
import { Button } from "../Button";
import { streamNow } from "../link";
import { effortLabel } from "../compose/Model";
import { forMac, newId } from "../compose/state";
import { lists } from "../mac/mac";
import { color, text } from "../theme";

/** A new session's id, made here as the desktop makes it, so the start can be asked again under it. */
export const sessionId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function Start({ project, name, onStarted }: { project: string; name: string; onStarted: (id: string, title: string) => void }) {
  const { run, drafts, unsaved } = forMac();
  const key = `@home:${project}`;
  const header = useHeaderHeight();
  const conn = useSyncExternalStore(lists.subscribe, () => (lists.get().ready ? streamNow() : -1));
  const connected = conn >= 0;
  const [words, setWords] = useState(() => plainText(drafts.draftOf(key)?.parts ?? []));
  const words$ = useRef(words);
  const put = (next: string) => {
    words$.current = next;
    setWords(next);
  };
  const [error, setError] = useState<string | null>(null);
  // The start being signed, as it goes and as the sheet shows it; `field`: its words are the field's.
  const [asking, setAsking] = useState<{ args: string[]; model: string; field: boolean } | null>(null);
  // A start whose outcome the phone can't settle: `open`, its session holds the message; else Try again sends the same
  // command under the same ids, or Discard takes it back. The field is free meanwhile.
  const [held, setHeld] = useState<{ args: string[]; model: string; error: string; open: boolean; busy?: boolean } | null>(null);

  useEffect(() => {
    void drafts.loadDraft(run, key).then((saved) => saved && !words$.current.trim() && put(plainText(saved.parts)));
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
      put(next);
      return { parts: next ? [next] : [], attachmentIds: [] };
    }),
  );
  const typed = (next: string) => {
    put(next);
    drafts.keepDraft(run, key, { parts: next ? [next] : [], attachmentIds: [] });
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
    if (!message || !choice) return;
    // The Mac reads words that start with `--` as a flag, so it refuses them.
    if (message.startsWith("--")) return setError("A message can't start with --");
    setError(null);
    const draft = { parts: [words$.current], attachmentIds: [] };
    const args = ["start", sessionId(), "--project", project, "--cid", newId(), "--draft", JSON.stringify(draft), "--draft-rev", String(drafts.revOf(key)), "--text", message, "--backend", choice.provider, "--model", choice.model, ...(choice.effort ? ["--effort", choice.effort] : []), ...(choice.fast ? ["--fast"] : [])];
    setAsking({ args, model: shown(choice), field: true });
  };
  const textOf = (args: string[]) => args[args.indexOf("--text") + 1]!;
  /** The start's reply, read by its outcome as the desktop's `land`, never by the session merely existing. */
  const land = (sent: { args: string[]; model: string; field: boolean }, reply: Record<string, any> | null) => {
    setAsking(null);
    if (!reply) return;
    const { args } = sent;
    const [id, cid] = [args[1]!, args[5]!];
    // Refused before it ran (no Face ID, not from the phone, turned off): the field keeps its words.
    const ran = reply.ok || reply.given_back || reply.went || reply.result !== undefined || "logged" in reply || reply.unsettled || reply.session || reply.left || reply.error === "closed";
    if (!ran) return setError(failure(reply));
    setError(null);
    // It left the field: what's typed from now on is another message.
    if (sent.field) put("");
    if (reply.given_back) {
      // Its session is gone, Rust says: its words are this draft's again, above what's typed.
      setHeld(null);
      if (reply.again || !Array.isArray(reply.parts)) drafts.resyncDraft(run, key);
      else drafts.takeBack(run, key, { cid: reply.cid ?? cid, parts: reply.parts, attachmentIds: reply.attachmentIds ?? [], error: failure(reply), typed: reply.typed });
      // A Discard's give-back is no refusal: nothing to say then.
      return setError(reply.message || reply.error ? failure(reply) : null);
    }
    if (sent.field) drafts.keepDraft(run, key, EMPTY_DRAFT);
    const delivered = reply.result === "delivered" || (reply.ok && reply.result === undefined) || reply.went || reply.result === "went" || reply.result === "settled";
    if (delivered) {
      setHeld(null);
      return onStarted(id, textOf(args).split("\n")[0]!.slice(0, 80));
    }
    // In its session's log, its agent not confirming it, or refusing it: the session shows how it went.
    const logged = reply.result === "logged" || reply.logged === true;
    const why = reply.result === "logged" ? String(reply.error ?? "It reached the log, but not the agent.") : String(reply.why ?? failure(reply));
    setHeld({ args, model: sent.model, open: logged, error: reply.error === "closed" ? "The connection to your Mac ended before it answered, so it may have started." : why });
  };
  /** Discard: Rust takes the start back (`drop`), its words into this draft, or says it went after all. */
  const discard = (args: string[]) => {
    setHeld((now) => now && { ...now, busy: true });
    void run(["draft", key, "drop", args[5]!]).then((reply) => {
      if (reply.given_back || reply.went) return land({ args, model: "", field: false }, reply);
      if (reply.ok) return setHeld(null);
      setHeld((now) => now && { ...now, busy: false, error: `Couldn't discard it: ${failure(reply)}` });
    });
  };

  const ready = connected && !!choice && words.trim() !== "";
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: color.background }} behavior="padding" keyboardVerticalOffset={header}>
      <SafeAreaView edges={["bottom"]} style={st.page}>
        <Text style={st.muted}>New chat in {name}</Text>
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
        {held && (
          <View style={st.held}>
            <Text style={st.pillText} numberOfLines={2}>{textOf(held.args)}</Text>
            <Text style={st.error}>{held.error}</Text>
            <View style={{ gap: 8 }}>
              {held.open ? (
                <Button title="Open the session" secondary onPress={() => onStarted(held.args[1]!, textOf(held.args).split("\n")[0]!.slice(0, 80))} />
              ) : (
                <>
                  <Button title="Try again" secondary disabled={held.busy || !connected} onPress={() => setAsking({ args: held.args, model: held.model, field: false })} />
                  <Button title="Discard" secondary disabled={held.busy || !connected} onPress={() => discard(held.args)} />
                </>
              )}
            </View>
          </View>
        )}
      </SafeAreaView>
      {asking && (
        <Confirm
          title="Start this chat on your Mac?"
          body={`In ${name}, on ${asking.model}.`}
          shown={textOf(asking.args)}
          args={asking.args}
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
