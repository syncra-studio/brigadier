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
import { effortLabel } from "../compose/Model";
import { forMac, newId } from "../compose/state";
import { lists } from "../mac/mac";
import { color, text } from "../theme";

/** A new session's id, made here as the desktop makes it, so the start can be asked again under it. */
export const sessionId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function Start({ project, name, onStarted }: { project: string; name: string; onStarted: (id: string, title: string) => void }) {
  const { run, drafts } = forMac();
  const key = `@home:${project}`;
  const header = useHeaderHeight();
  const connected = useSyncExternalStore(lists.subscribe, () => lists.get().ready);
  const [words, setWords] = useState(() => plainText(drafts.draftOf(key)?.parts ?? []));
  const words$ = useRef(words);
  const put = (next: string) => {
    words$.current = next;
    setWords(next);
  };
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<string[] | null>(null);
  // Kept while no answer says it went or came back, so Start again asks under the same ids.
  const ids = useRef<{ id: string; cid: string } | null>(null);

  useEffect(() => {
    void drafts.loadDraft(run, key).then((saved) => saved && !words$.current.trim() && put(plainText(saved.parts)));
  }, []);
  // Given back: the field held just what was sent (the sheet was over it), so the words take its place.
  useEffect(() =>
    drafts.onGiven(key, (back) => {
      put(plainText(back.parts));
      return { parts: back.parts, attachmentIds: [] };
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
    ids.current ??= { id: sessionId(), cid: newId() };
    const { id, cid } = ids.current;
    const draft = { parts: [words$.current], attachmentIds: [] };
    setAsking(["start", id, "--project", project, "--cid", cid, "--draft", JSON.stringify(draft), "--draft-rev", String(drafts.revOf(key)), "--text", message, "--backend", choice.provider, "--model", choice.model, ...(choice.effort ? ["--effort", choice.effort] : []), ...(choice.fast ? ["--fast"] : [])]);
  };
  /** The start's reply, read by its outcome as the desktop's `land`, never by the session merely existing. */
  const land = (args: string[], reply: Record<string, any> | null) => {
    setAsking(null);
    if (!reply) return;
    const [id, cid] = [args[1]!, args[5]!];
    if (reply.given_back) {
      // Its session is gone, Rust says: its words are this draft's again. New ids for the next try.
      ids.current = null;
      if (reply.again || !Array.isArray(reply.parts)) drafts.resyncDraft(run, key);
      else drafts.takeBack(run, key, { cid: reply.cid ?? cid, parts: reply.parts, attachmentIds: reply.attachmentIds ?? [], error: failure(reply), typed: reply.typed });
      return setError(failure(reply));
    }
    const went = reply.ok || reply.logged === true || reply.went || ["delivered", "logged", "went", "settled"].includes(reply.result);
    if (!went) return setError(reply.error === "closed" ? "The connection to your Mac ended before it answered. Check your sessions before you start this again." : failure(reply));
    ids.current = null;
    put("");
    drafts.keepDraft(run, key, EMPTY_DRAFT);
    onStarted(id, args[args.indexOf("--text") + 1]!.split("\n")[0]!.slice(0, 80));
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
      </SafeAreaView>
      {asking && choice && (
        <Confirm
          title="Start this chat on your Mac?"
          body={`In ${name}, on ${shown(choice)}.`}
          shown={asking[asking.indexOf("--text") + 1]!}
          args={asking}
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
});
