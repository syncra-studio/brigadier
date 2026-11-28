// The cards waiting on the user, after the desktop's composer approval.tsx and question.tsx. With a `session` they are
// answered from here: one-time answers straight through, lasting ones through the Face ID sheet; without, read only.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { PendingApproval, PendingQuestion } from "../../../app/shared/cards";
import type { Frame } from "../../../app/shared/client";
import { Confirm } from "../act/Confirm";
import { answering, forget, send, settle } from "../cards/answers";
import { ask } from "../link";
import { lists } from "../mac/mac";
import { color, text } from "../theme";
import { describe } from "./rows/asks";

/** A worker's approval on its parent's card: the worker answers it. */
type Approval = PendingApproval & { session?: string; parent?: string };

export function Cards({ approvals, questions, session }: { approvals?: PendingApproval[]; questions?: PendingQuestion[]; session?: string }) {
  const all = useSyncExternalStore(answering.subscribe, answering.get);
  const { workers, seen } = useWorkerApprovals(session);
  const mine = (owner: string) => all.get(owner) ?? new Map();
  const listed = new Set([...(approvals ?? []), ...(questions ?? []), ...workers].map((card) => card.id));
  // A taken answer goes once Rust no longer lists its card (a worker's once its own list has been read again); one
  // refused stays, with Dismiss once nothing waits on it.
  useEffect(() => {
    for (const [owner, answers] of all)
      for (const [id, answer] of answers) if (!answer.error && !listed.has(id) && (owner === session || seen.has(owner))) forget(owner, id);
  });
  if (!session) return <List approvals={approvals ?? []} questions={questions ?? []} />;
  const shows = (owner: string, id: string) => mine(owner).get(id)?.error !== undefined || !mine(owner).has(id);
  // Its own refused cards and its workers', those of a worker since gone included.
  const stale = [...all].flatMap(([owner, answers]) => [...answers.values()].filter((answer) => answer.error !== undefined && !listed.has(answer.card.id) && (owner === session || (answer.card as Approval).parent === session)).map((answer) => answer.card));
  const shownApprovals: Approval[] = [...(approvals ?? []), ...workers, ...stale.filter((card): card is PendingApproval => !("items" in card))]
    .filter((card) => shows((card as Approval).session ?? session, card.id))
    // A plan its review holds, or its agent revises, has nothing to answer: what can be answered shows first [D395, D401].
    .sort((a, b) => Number(Boolean(a.review || a.revising)) - Number(Boolean(b.review || b.revising)));
  const shownQuestions = [...(questions ?? []), ...stale.filter((card): card is PendingQuestion => "items" in card)].filter((card) => shows(session, card.id));
  return <List approvals={shownApprovals} questions={shownQuestions} session={session} listed={listed} />;
}

function List({ approvals, questions, session, listed }: { approvals: Approval[]; questions: PendingQuestion[]; session?: string; listed?: Set<string> }) {
  const all = useSyncExternalStore(answering.subscribe, answering.get);
  if (!approvals.length && !questions.length) return null;
  const answer = (owner: string, id: string) => all.get(owner)?.get(id);
  return (
    <View style={st.cards}>
      {approvals.map((approval) => {
        const owner = approval.session ?? session;
        const error = owner ? answer(owner, approval.id)?.error : undefined;
        return <ApprovalCard key={`${owner}:${approval.id}`} approval={approval} owner={owner} error={error} onDismiss={owner && error && !listed?.has(approval.id) ? () => forget(owner, approval.id) : undefined} />;
      })}
      {questions.map((question) => {
        const error = session ? answer(session, question.id)?.error : undefined;
        return <QuestionCard key={question.id} question={question} session={session} error={error} onDismiss={session && error && !listed?.has(question.id) ? () => forget(session, question.id) : undefined} />;
      })}
    </View>
  );
}

/**
 * The approvals the session's workers wait on the user for, read from each with `peek` as its row changes. `seen`: the
 * workers whose list as it is now is known (read, or not asking), so a taken answer of theirs can go.
 */
function useWorkerApprovals(session: string | undefined): { workers: Approval[]; seen: Set<string> } {
  const rows = useSyncExternalStore(lists.subscribe, () => lists.get().rows);
  const workers = session ? rows.filter((row) => row.worker?.parent === session) : [];
  const asking = workers.filter((row) => row.worker!.kind === "needsYou");
  const key = asking.map((row) => `${row.id}:${row.updated}`).join(" ");
  const [found, setFound] = useState<{ key: string; approvals: Approval[]; read: Set<string> }>({ key: "", approvals: [], read: new Set() });
  useEffect(() => {
    let live = true;
    if (!asking.length) return setFound({ key, approvals: [], read: new Set() });
    Promise.all(
      asking.map((row) =>
        ask({ op: "peek", session: row.id })
          .then((reply) => (reply.ok ? { id: row.id, approvals: (reply.session.approvals ?? []).map((each: PendingApproval): Approval => ({ ...each, agent: row.title, session: row.id, parent: session })) } : null))
          .catch(() => null),
      ),
    ).then((each) => {
      if (!live) return;
      const read = each.filter((one) => one !== null);
      // A worker whose read failed keeps the cards last read for it, until its row changes and it is read again.
      setFound((was) => ({
        key,
        approvals: [...read.flatMap((one) => one.approvals), ...was.approvals.filter((card) => asking.some((row) => row.id === card.session) && !read.some((one) => one.id === card.session))],
        read: new Set(read.map((one) => one.id)),
      }));
    });
    return () => {
      live = false;
    };
  }, [key]);
  const current = found.key === key;
  const seen = new Set(workers.filter((row) => (row.worker!.kind === "needsYou" ? current && found.read.has(row.id) : true)).map((row) => row.id));
  return { workers: found.approvals, seen };
}

/** The buttons' words by kind, as the desktop's describe gives them. */
const LABELS: Partial<Record<PendingApproval["action"], { allow?: string; deny?: string; noDeny?: boolean }>> = {
  land: { allow: "Land" },
  plan: { allow: "Build it", noDeny: true },
  message: { allow: "Send", deny: "Don't send" },
  browser: { allow: "Go ahead", deny: "Don't" },
  computer: { allow: "Allow in this chat" },
};

/** What "Allow for this session" covers, as the desktop's tip says it; its words never change [D167]. */
function grantTip({ scope, pattern }: NonNullable<PendingApproval["grant"]>): string {
  const kept = "Brigadier keeps this until the chat ends.";
  if (scope === "edits") return `Allow file changes inside ${pattern} in this chat. Edits outside it still ask. ${kept}`;
  if (scope === "tool") return `Allow ${pattern} in this chat. ${kept}`;
  if (scope === "site") return `Allow scripts, clicks, typing, deletes and sends on ${pattern} in this chat. Paying, cards, passwords, codes and sign-in still ask. ${kept}`;
  if (scope === "network") return `Allow connections to ${pattern} in this chat. ${kept}`;
  return `Allow commands that start with ${pattern} in this chat. ${kept}`;
}

/** What the Face ID sheet shows whole: the thing asked about, exactly. */
const asked = (a: PendingApproval) => a.command ?? a.paths?.join("\n") ?? (a.host ? `https://${a.host}` : undefined) ?? a.input ?? a.body ?? a.reason ?? describe(a).title;

const FLAG = "It can't start with --.";
type Sheet = { title: string; body?: string; shown: string; args: string[] };

/**
 * An approval: kind (and the worker asking), the reason as the title, the exact thing asked about; then Deny, Allow for
 * this session, Allow once. Words typed turn it to refusing: Allow becomes Send, which denies with them [D182, D192].
 */
function ApprovalCard({ approval, owner, error, onDismiss }: { approval: Approval; owner?: string; error?: string; onDismiss?: () => void }) {
  const shown = describe(approval);
  const labels = LABELS[approval.action] ?? {};
  const [typed, setTyped] = useState("");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [local, setLocal] = useState<string | null>(null);
  const waits = Boolean(approval.review || approval.revising);
  const reason = typed.trim();
  const base = owner ? ["answer", owner, approval.id] : [];
  const once = (args: string[]) => {
    if (!owner) return;
    setLocal(null);
    void send(owner, approval, [...base, ...args]);
  };
  const deny = () => {
    if (reason.startsWith("--")) return setLocal(FLAG);
    once(reason ? ["deny", "--reason", reason] : ["deny"]);
  };
  // Computer use lasts for the chat and a permission request for the turn: both are signed, as a session grant is.
  const lastingAllow = approval.action === "computer" || approval.action === "permission";
  const sign = (next: Sheet) => {
    setLocal(null);
    setSheet(next);
  };
  const allow = () =>
    lastingAllow
      ? sign({ title: approval.action === "computer" ? "Allow in this chat?" : "Allow this?", body: shown.title, shown: asked(approval), args: [...base, "allow"] })
      : once(["allow"]);
  const done = (reply: Frame | null) => {
    setSheet(null);
    if (reply && owner) settle(owner, approval, reply);
  };
  return (
    <View style={st.card} accessibilityLabel="Approval">
      <Text style={st.kind}>{shown.kind}{approval.agent ? ` · ${approval.agent}` : ""}</Text>
      <Text style={st.title} accessibilityRole="header">{shown.title}{approval.review?.waits && !approval.revising ? " · waiting for you" : ""}</Text>
      {shown.detail ? <Text style={st.detail}>{shown.detail}</Text> : null}
      {shown.body || null}
      <Problem error={local ?? error} onDismiss={onDismiss} />
      {!owner ? <OnMac /> : waits ? null : (
        <>
          <TextInput style={st.field} value={typed} onChangeText={setTyped} placeholder="Tell the agent what to do instead" placeholderTextColor={color.mutedForeground} multiline accessibilityLabel="What to do instead" />
          <View style={st.buttons}>
            {reason ? (
              <Small title={approval.action === "message" ? "Send instead" : "Send"} primary onPress={deny} />
            ) : (
              <>
                {!labels.noDeny && <Small title={labels.deny ?? "Deny"} onPress={deny} />}
                {approval.grant && (
                  <Small title="Allow for this session" onPress={() => sign({ title: "Allow for this session?", body: grantTip(approval.grant!), shown: asked(approval), args: [...base, "allowSession"] })} />
                )}
                <Small title={labels.allow ?? "Allow once"} primary onPress={allow} />
              </>
            )}
          </View>
        </>
      )}
      {sheet && <Confirm {...sheet} onDone={done} />}
    </View>
  );
}

// Where the user is on a question card, kept outside it so leaving the thread and coming back finds it as it was.
type Kept = { at: number; answers: (string | null)[]; marked: number[]; typed: string };
const kept = new Map<string, Kept>();
const FRESH: Kept = { at: 0, answers: [], marked: [], typed: "" };

/**
 * A question or a round of them, one at a time: tap an answer, mark several, or type your own; Skip leaves it to the
 * asker. The round goes together after the last. A worker's routing hold takes only its own answers, no Skip [D2028].
 */
function QuestionCard({ question, session, error, onDismiss }: { question: PendingQuestion; session?: string; error?: string; onDismiss?: () => void }) {
  const key = `${session}\n${question.id}`;
  const [state, setState] = useState<Kept>(() => kept.get(key) ?? FRESH);
  const keep = (next: Kept) => {
    kept.set(key, next);
    setState(next);
  };
  const { items } = question;
  const at = Math.min(state.at, items.length - 1);
  const item = items[at];
  if (!item) return null;
  const answer = (given: string | null) => {
    const answers = items.map((_, i) => (i === at ? given : (state.answers[i] ?? null)));
    if (at < items.length - 1) return keep({ at: at + 1, answers, marked: [], typed: "" });
    // Kept until the Mac takes it: a refused round comes back as it was sent.
    keep({ ...state, answers });
    void send(session!, question, ["answer", session!, question.id, "--answers", JSON.stringify(answers)]).then(() => {
      if (answering.get().get(session!)?.get(question.id)?.error === undefined) kept.delete(key);
    });
  };
  const typed = state.typed.trim();
  const last = at === items.length - 1;
  return (
    <View style={st.card} accessibilityLabel="Question">
      {question.title || items.length > 1 ? (
        <Text style={st.kind}>{[question.title, items.length > 1 ? `${at + 1} of ${items.length}` : ""].filter(Boolean).join(" · ")}</Text>
      ) : null}
      <Text style={st.title} accessibilityRole="header">{item.text}</Text>
      {item.options.map((option, n) => {
        const marked = state.marked.includes(n);
        const press = !session ? undefined : item.multiSelect ? () => keep({ ...state, marked: marked ? state.marked.filter((m) => m !== n) : [...state.marked, n] }) : () => answer(option.label);
        return (
          <Pressable key={n} onPress={press} accessibilityRole={session ? "button" : undefined} accessibilityState={item.multiSelect ? { checked: marked } : undefined} style={({ pressed }) => [st.option, (marked || pressed) && st.optionOn]}>
            <Text style={st.number}>{item.multiSelect && session ? (marked ? "☑" : "☐") : n + 1}</Text>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={st.label}>
                {option.label}
                {item.recommended === n ? <Text style={st.recommended}>  Recommended</Text> : null}
              </Text>
              {option.description ? <Text style={st.detail}>{option.description}</Text> : null}
            </View>
          </Pressable>
        );
      })}
      <Problem error={error} onDismiss={onDismiss} />
      {!session ? <OnMac /> : (
        <>
          {!question.held && (
            <TextInput style={st.field} value={state.typed} onChangeText={(t) => keep({ ...state, typed: t })} placeholder="Your own answer" placeholderTextColor={color.mutedForeground} multiline accessibilityLabel="Your own answer" />
          )}
          <View style={st.buttons}>
            {at > 0 && <Small title="Back" onPress={() => keep({ ...state, at: at - 1, ...restored(items[at - 1]!, state.answers[at - 1] ?? null) })} />}
            {!question.held && <Small title="Skip" onPress={() => answer(null)} />}
            {typed ? (
              <Small title={last ? "Send" : "Next"} primary onPress={() => answer(typed)} />
            ) : item.multiSelect ? (
              <Small title={last ? "Send" : "Next"} primary disabled={!state.marked.length} onPress={() => answer(state.marked.slice().sort((a, b) => a - b).map((m) => item.options[m]!.label).join(", "))} />
            ) : null}
          </View>
        </>
      )}
    </View>
  );
}

/** A question gone back to shows its answer as given: its marks, or its own words (a picked single answer shows as words too, so Next keeps it). */
function restored(item: PendingQuestion["items"][number], given: string | null): { marked: number[]; typed: string } {
  if (given === null) return { marked: [], typed: "" };
  const labels = item.options.map((option) => option.label);
  const marks = item.multiSelect ? given.split(", ").map((label) => labels.indexOf(label)) : [];
  if (marks.length && marks.every((m) => m >= 0)) return { marked: marks, typed: "" };
  return { marked: [], typed: given };
}

function Problem({ error, onDismiss }: { error?: string | null; onDismiss?: () => void }) {
  if (!error) return null;
  return (
    <View style={st.problem}>
      <Text style={[st.detail, { color: color.destructive, flex: 1 }]} accessibilityRole="alert">{error}</Text>
      {onDismiss && <Small title="Dismiss" onPress={onDismiss} />}
    </View>
  );
}

function Small({ title, onPress, primary, disabled }: { title: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} onPress={disabled ? undefined : onPress} hitSlop={6} style={({ pressed }) => [st.small, primary && st.smallPrimary, (pressed || disabled) && { opacity: disabled ? 0.4 : 0.8 }]}>
      <Text style={[st.smallText, primary && { color: color.primaryFg }]}>{title}</Text>
    </Pressable>
  );
}

const OnMac = () => <Text style={st.onMac}>Answer on your Mac</Text>;

const st = StyleSheet.create({
  cards: { gap: 12, paddingTop: 24 },
  card: { gap: 10, borderRadius: 16, backgroundColor: color.muted, padding: 16 },
  kind: { fontSize: 13, lineHeight: 20, color: color.mutedForeground },
  title: { ...text.base, fontWeight: "500", color: color.foreground },
  detail: { ...text.sm, color: color.mutedForeground },
  option: { flexDirection: "row", gap: 10, borderRadius: 10, backgroundColor: color.fill, paddingHorizontal: 12, paddingVertical: 8 },
  optionOn: { backgroundColor: color.fillActive },
  number: { ...text.sm, minWidth: 14, color: color.mutedForeground },
  label: { ...text.sm, color: color.foreground },
  recommended: { fontSize: 12, color: color.mutedForeground },
  onMac: { ...text.sm, color: color.mutedForeground, paddingTop: 2 },
  field: { ...text.sm, color: color.foreground, backgroundColor: color.fill, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, maxHeight: 120 },
  buttons: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 },
  small: { borderRadius: 999, backgroundColor: color.fill, paddingHorizontal: 14, paddingVertical: 8 },
  smallPrimary: { backgroundColor: color.primary },
  smallText: { ...text.sm, fontWeight: "600", color: color.foreground },
  problem: { flexDirection: "row", alignItems: "center", gap: 8 },
});
