// New chat in a project, as the desktop's home/start.ts starts one [D30, D161, C65]: this iPhone's own Home draft of
// the project (`@home:<project>`, kept by Rust), the project's last model, and the start signed with Face ID. The Mac
// picks the worktree and the project's level. Refused, Rust gives the words back into this draft; nothing is sent again
// by itself.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActionSheetIOS, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useHeaderHeight } from "@react-navigation/elements";
import { type Chip, type Draft, EMPTY_DRAFT, plainText } from "../../../app/shared/draft";
import { baseBranches, type RepoInfo } from "../../../app/shared/rows";
import { asGroups, type ModelChoice, type ModelGroup, type ModelRow } from "../../../app/shared/session/model";
import { failure } from "../../../app/shared/session/run";
import { flagOf, type Going, UNCONFIRMED } from "../../../app/shared/session/uncertain";
import { Confirm } from "../act/Confirm";
import { streamNow } from "../link";
import { ArrowUp, Bolt, Branch } from "../../../app/ui/src/icons";
import { BrigadierMark } from "../../../app/ui/src/onboarding/mark";
import { ProviderMark } from "../compose/KindIcons";
import { COMPOSER_WORDS, effortLabel } from "../../../app/shared/session/composer";
import { HOME_WORDS } from "../../../app/shared/words";
import { Link, st as cs } from "../compose/parts";
import { Pill } from "../compose/Pill";
import { canned, forMac, newId } from "../compose/state";
import { lists } from "../mac/mac";
import { color, fontWeight, opacity, space, spacing, text, touch, tracking } from "../theme";

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
  const { height } = useWindowDimensions();
  const conn = useSyncExternalStore(lists.subscribe, () => (lists.get().ready ? streamNow() : -1));
  // A sample screen's canned replies stand in for the Mac.
  const connected = conn >= 0 || !!canned.reply;
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
  const found = (each: ModelChoice) => offered.find(({ group, model }) => group.provider === each.provider && model.id === each.model);
  // Its words for a screen reader, as the desktop's modelWords: "GPT-5.5, Fast, High".
  const shown = (each: ModelChoice) => [found(each)?.model.name ?? each.model, each.fast ? "Fast" : null, each.effort ? effortLabel(each.effort) : null].filter(Boolean).join(", ");
  const pick = () =>
    ActionSheetIOS.showActionSheetWithOptions({ title: "Model", options: [...offered.map(({ group, model }) => `${group.short ?? group.label} · ${model.name}`), "Cancel"], cancelButtonIndex: offered.length }, (at) => {
      const was = offered[at];
      if (was) setPicked({ provider: was.group.provider, model: was.model.id, effort: was.model.defaultEffort ?? null });
    });

  // The base branch, as the desktop's branch pill picks it: the project's branches, the checked-out one first; none
  // picked, the Mac starts from the checked-out one.
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    if (connected) void run(["projects", "branches", project]).then((reply) => reply.ok && setRepo(reply.repo));
  }, [connected]);
  const listed = repo ? baseBranches(repo) : [];
  const pickBase = () =>
    ActionSheetIOS.showActionSheetWithOptions({ title: "Base branch", options: [...listed, "Cancel"], cancelButtonIndex: listed.length }, (at) => listed[at] && setBase(listed[at]));

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
    const op = ["start", sessionId(), "--project", project, "--cid", cid, "--draft", JSON.stringify(draft), "--draft-rev", String(rev), "--text", message, ...(withFiles ? ["--parts", JSON.stringify(draft)] : []), "--backend", choice.provider, "--model", choice.model, ...(choice.effort ? ["--effort", choice.effort] : []), ...(choice.fast ? ["--fast"] : []), ...(base ? ["--base", base] : [])];
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

  const blank = words.trim() === "" && files.ids.length + files.chips.length === 0;
  // Why Start waits, in the desktop's words for its Send.
  const waits = !connected ? COMPOSER_WORDS.reconnecting : groups && !choice ? HOME_WORDS.pickModel : undefined;
  const off = blank || !choice || waits !== undefined;
  const branch = base ?? repo?.current ?? HOME_WORDS.pickBranch;
  const model = choice && found(choice);
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: color.background }} behavior="padding" keyboardVerticalOffset={header}>
      {/* The desktop's home/view.tsx: the hero ends a little above the middle, the composer sits at the bottom; each takes half. */}
      <View style={st.hero}>
        <BrigadierMark className="size-16 text-foreground opacity-60" />
        <Text style={st.heroText}>{`${HOME_WORDS.buildIn} ${name}?`}</Text>
      </View>
      <SafeAreaView edges={{ bottom: "maximum" }} style={[cs.column, st.half]}>
        {landed && (
          <View style={cs.going}>
            <Text style={cs.goingText} numberOfLines={2}>{landed.title}</Text>
            <Text style={cs.error}>{landed.error}</Text>
            <View style={cs.actions}>
              <Link title="Open the session" onPress={() => onStarted(landed.id, landed.title)} />
            </View>
          </View>
        )}
        {held.map((entry) => (
          <View key={entry.cid} style={cs.going}>
            <Text style={cs.goingText} numberOfLines={2}>{textOf(entry.op) || plainText(entry.draft.parts)}</Text>
            {/* None held here is on its way: one kept with no answer (a relaunch mid-way) couldn't be confirmed. */}
            <Text style={cs.error}>{entry.stuck ?? UNCONFIRMED}</Text>
            <View style={cs.actions}>
              {!entry.left && <Link title="Try again" disabled={busy.has(entry.cid) || !connected || !!asking} onPress={() => setAsking({ entry: { ...entry, op: phoneOp(entry) }, fresh: false })} />}
              <Link title="Discard" disabled={busy.has(entry.cid) || !connected || !!asking} onPress={() => discard(entry)} />
            </View>
          </View>
        ))}
        {files.ids.length + files.chips.length > 0 && (
          <Text style={cs.muted}>
            {(() => {
              const n = new Set([...files.ids, ...files.chips.map((chip) => ("attachmentId" in chip ? chip.attachmentId : ""))]).size;
              return n === 1 ? "1 file goes with it · " : `${n} files go with it · `;
            })()}
            <Text style={cs.link} accessibilityRole="button" onPress={() => typed(words$.current, NO_FILES)}>Remove</Text>
          </Text>
        )}
        {/* The desktop's NoticeRow over the composer: the whole refusal, never cut. */}
        {error ? <Text style={cs.error}>{`${HOME_WORDS.couldntStart} ${error}`}</Text> : null}
        {/* The rail's utility bar: the branch pill, held unseen in its place until the first read. */}
        <View style={cs.rail}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.bar}>
            <View style={!repo && { opacity: 0 }} pointerEvents={repo ? "auto" : "none"}>
              <Pill label={`Base branch: ${branch}`} disabled={listed.length === 0} onPress={pickBase} style={{ maxWidth: space(80) }}>
                <Branch className="size-icon-md text-foreground" />
                <Text style={st.pillText} numberOfLines={1}>{branch}</Text>
              </Pill>
            </View>
          </ScrollView>
        </View>
        <View style={cs.card}>
          <TextInput style={[cs.input, { maxHeight: height * 0.25 }]} multiline autoFocus value={words} onChangeText={typed} placeholder={COMPOSER_WORDS.placeholder} placeholderTextColor={color.placeholder} accessibilityLabel="Message" />
          <View style={cs.footer}>
            <View style={cs.end}>
              {!error && groups && !choice ? <Text style={cs.status} numberOfLines={2}>{HOME_WORDS.noModel}</Text> : null}
              {choice && (
                <Pill label={`Model: ${shown(choice)}`} disabled={offered.length === 0} onPress={pick}>
                  <ProviderMark mark={model?.group.mark} />
                  <Text style={st.pillText} numberOfLines={1}>{model?.model.name ?? choice.model}</Text>
                  {choice.fast ? <Bolt className="size-icon-xs text-glyph-5" /> : null}
                  {choice.effort ? <Text style={st.effort} numberOfLines={1}>{effortLabel(choice.effort)}</Text> : null}
                </Pill>
              )}
              <Pressable accessibilityRole="button" accessibilityLabel={waits ?? "Start"} accessibilityState={{ disabled: off }} disabled={off} onPress={start} hitSlop={(touch - spacing.controlSm) / 2} style={({ pressed }) => [cs.send, off ? { opacity: opacity.disabled } : pressed && { opacity: 0.8 }]}>
                <ArrowUp className="size-icon-md text-primary-fg" />
              </Pressable>
            </View>
          </View>
        </View>
        {/* Why Start waits: the desktop's tip for its Send, which a phone can't hover. */}
        {waits && (!blank || !connected) ? <Text style={cs.waits}>{waits}</Text> : null}
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

const half = { flexGrow: 1, flexBasis: 0, justifyContent: "flex-end" } as const;
const st = StyleSheet.create({
  // The hero: items-center justify-end gap-6 px-4 pb-11; its words text-hero, normal, tracking-hero.
  hero: { ...half, alignItems: "center", gap: space(6), paddingHorizontal: space(4), paddingBottom: space(11) },
  heroText: { ...text.hero, fontWeight: fontWeight.normal, letterSpacing: tracking.hero * text.hero.fontSize, color: color.foreground, textAlign: "center" },
  half,
  // UtilityBar: px-1 py-1.25, its pills gap-2.
  bar: { flexDirection: "row", alignItems: "center", gap: space(2), paddingHorizontal: space(1), paddingVertical: space(1.25) },
  // A rail pill's bright words (RAIL_PILL), and the model pill's as compose/Model.tsx draws them.
  pillText: { ...text.sm, color: color.foreground, flexShrink: 1 },
  effort: { ...text.sm, color: color.mutedForeground, flexShrink: 0 },
});
