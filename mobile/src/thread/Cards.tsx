// The cards waiting on the user, after the desktop's composer approval.tsx, question.tsx and decision-parts.tsx. With a `session` they are
// answered from here: one-time answers straight through, lasting ones through the Face ID sheet; without, read only.
import { type ComponentType, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { grantTip, moreWaiting, type PendingApproval, type PendingQuestion } from "../../../app/shared/cards";
import type { Frame } from "../../../app/shared/client";
import { Confirm } from "../act/Confirm";
import { answering, forget, send, settle } from "../cards/answers";
import { ask } from "../link";
import { lists } from "../mac/mac";
import { ChevronRight, Commit, Cursor, Dock, Globe, type IconProps, Key, Pencil, PencilSquare, Sparkle, X } from "../../../app/ui/src/icons";
import { color, fontWeight, opacity, radius, space, spacing, text, touch } from "../theme";
import { ThreadImage } from "./Image";
import { CodeSpans, describe } from "./rows/asks";

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

/** The approvals, then the questions, each one at a time as the desktop shows them: questions on the rail, approvals in the composer's place. */
function List({ approvals, questions, session, listed }: { approvals: Approval[]; questions: PendingQuestion[]; session?: string; listed?: Set<string> }) {
  const all = useSyncExternalStore(answering.subscribe, answering.get);
  const approval = useShown(approvals);
  const question = useShown(questions);
  if (!approval.card && !question.card) return null;
  const answer = (owner: string, id: string) => all.get(owner)?.get(id);
  const owner = approval.card ? (approval.card.session ?? session) : undefined;
  const approvalError = owner && approval.card ? answer(owner, approval.card.id)?.error : undefined;
  const questionError = session && question.card ? answer(session, question.card.id)?.error : undefined;
  return (
    <View style={st.cards}>
      {question.card && (
        <View style={st.rail} accessibilityLabel="Waiting for you">
          <QuestionCard
            key={question.card.id}
            question={question.card}
            session={session}
            error={questionError}
            onDismiss={session && questionError && !listed?.has(question.card.id) ? () => forget(session, question.card!.id) : undefined}
          />
          {questions.length > 1 && (
            <View style={st.more}>
              <Text style={st.moreText}>{questions.length - 1 - question.at > 0 ? moreWaiting(questions.length - 1 - question.at) : ""}</Text>
              <StepCounter noun="decision" at={question.at} count={questions.length} canBack={question.at > 0} canForward={question.at < questions.length - 1} onStep={(by) => question.show(question.at + by)} />
            </View>
          )}
        </View>
      )}
      {approval.card && (
        <View style={st.slot}>
          <ApprovalCard
            key={`${owner}:${approval.card.id}`}
            approval={approval.card}
            owner={owner}
            error={approvalError}
            onDismiss={owner && approvalError && !listed?.has(approval.card.id) ? () => forget(owner, approval.card!.id) : undefined}
            step={{ index: approval.at, total: approvals.length, onStep: approval.show }}
          />
        </View>
      )}
    </View>
  );
}

/** The card shown, by id, so another coming or going doesn't change it; where it was, for the one after it when it goes. */
function useShown<T extends { id: string }>(cards: readonly T[]) {
  const [shown, setShown] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  const found = cards.findIndex((each) => each.id === shown.id);
  const at = Math.max(found >= 0 ? found : Math.min(shown.index, cards.length - 1), 0);
  return { card: cards[at] as T | undefined, at, show: (index: number) => setShown({ id: cards[index]?.id ?? null, index }) };
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

/** What the Face ID sheet shows whole: the thing asked about, exactly. */
const asked = (a: PendingApproval) => a.command ?? a.paths?.join("\n") ?? (a.host ? `https://${a.host}` : undefined) ?? a.input ?? a.body ?? a.reason ?? describe(a).title;

const FLAG = "It can't start with --.";
type Sheet = { title: string; body?: string; shown: string; args: string[] };

/** The card's icon by what it asks, as the desktop's describe gives it. */
const ICONS: Partial<Record<PendingApproval["action"], ComponentType<IconProps>>> = { command: Dock, edit: PencilSquare, network: Globe, land: Commit, plan: Sparkle, message: Sparkle, browser: Globe, computer: Cursor };

/** Where a card stands among those waiting: "1 of 3", with ‹ › to step between them. */
type Step = { index: number; total: number; onStep: (index: number) => void };

/**
 * An approval, as the desktop's ApprovalCard: kind (and the worker asking), the reason as the title, the exact thing
 * asked about; then the field, Deny, Allow for this session, Allow once. Words typed turn it to refusing: Deny and the
 * session grant make way, Allow becomes Send, which denies with them [D182, D192]. Lasting answers go through Face ID.
 */
// The refusal typed on an approval, by its owner and id, kept outside the card: paging between cards keeps it.
const reasons = new Map<string, string>();

function ApprovalCard({ approval, owner, error, onDismiss, step }: { approval: Approval; owner?: string; error?: string; onDismiss?: () => void; step: Step }) {
  const shown = describe(approval);
  const reasonKey = `${owner}\n${approval.id}`;
  const [typed, setReason] = useState(() => reasons.get(reasonKey) ?? "");
  const setTyped = (next: string) => (reasons.set(reasonKey, next), setReason(next));
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [local, setLocal] = useState<string | null>(null);
  const waits = Boolean(approval.review || approval.revising);
  const reason = typed.trim();
  const base = owner ? ["answer", owner, approval.id] : [];
  const once = (args: string[]) => {
    if (!owner) return;
    setLocal(null);
    void send(owner, approval, [...base, ...args]).then(() => {
      // Answered: its words go; refused, they stay for the next try.
      if (answering.get().get(owner)?.get(approval.id)?.error === undefined) reasons.delete(reasonKey);
    });
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
  const Icon = ICONS[approval.action] ?? Key;
  return (
    <View style={st.card} accessibilityLabel="Approval">
      <View style={st.head}>
        <View style={st.kindRow}>
          <Icon className="size-4.5 shrink-0 text-card-kind" />
          <Text style={st.kind}>{shown.kind}</Text>
          {approval.agent ? <Text style={[st.kind, st.shrink]} numberOfLines={1}>· {approval.agent}</Text> : null}
          {step.total > 1 && (
            <View style={st.end}>
              <StepCounter noun="request" at={step.index} count={step.total} canBack={step.index > 0} canForward={step.index < step.total - 1} onStep={(by) => step.onStep(step.index + by)} />
            </View>
          )}
        </View>
        <Title detail={shown.detail}>
          <CodeSpans text={shown.title} />
          {approval.review?.waits && !approval.revising ? " · waiting for you" : ""}
        </Title>
      </View>
      {shown.body || null}
      <Problem error={local ?? error} onDismiss={onDismiss} style={{ paddingTop: space(2) }} />
      {!owner ? <OnMac /> : waits ? null : (
        <View style={st.actions}>
          <FreeText style={st.reason}>
            <TextInput style={st.field} value={typed} onChangeText={setTyped} placeholder="Tell the agent what to do instead" placeholderTextColor={color.placeholder} multiline accessibilityLabel="What to do instead" />
          </FreeText>
          <View style={st.buttons}>
            {reason ? (
              <Action title={approval.action === "message" ? "Send instead" : "Send"} primary onPress={deny} />
            ) : (
              <>
                {!shown.noDeny && <Action title={shown.deny ?? "Deny"} onPress={deny} />}
                {approval.grant && (
                  <Action title="Allow for this session" onPress={() => sign({ title: "Allow for this session?", body: grantTip(approval.grant!), shown: asked(approval), args: [...base, "allowSession"] })} />
                )}
                <Action title={shown.allow ?? "Allow once"} primary onPress={allow} />
              </>
            )}
          </View>
        </View>
      )}
      {sheet && <Confirm {...sheet} onDone={done} />}
    </View>
  );
}

// Where the user is on a question card, kept outside it so leaving the thread and coming back finds it as it was:
// an answer per question (undefined still open, null skipped).
type Kept = { at: number; answers: (string | null | undefined)[]; marked: number[]; typed: string };
const kept = new Map<string, Kept>();
const FRESH: Kept = { at: 0, answers: [], marked: [], typed: "" };
/** How long a picked answer shows its dot before it goes, as the desktop's. */
const COMMIT_MS = 300;

/**
 * A question card, as the desktop's: its round one question at a time with "‹ 1 of 3 ›", numbered answers (a pick shows
 * its dot, then goes; several marked with a multi-select), then the field with Skip, which turns to Next, or Submit on the
 * round's last. ✕ skips all still open. A worker's routing hold takes only its own answers: no field, no Skip [D2028].
 */
function QuestionCard({ question, session, error, onDismiss }: { question: PendingQuestion; session?: string; error?: string; onDismiss?: () => void }) {
  const key = `${session}\n${question.id}`;
  const [state, setState] = useState<Kept>(() => kept.get(key) ?? FRESH);
  const [chosen, setChosen] = useState<number | null>(null);
  // A pick's dot, before it answers: while it waits, nothing else answers or moves the card.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<(given: string) => void>(() => {});
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const keep = (next: Kept) => {
    kept.set(key, next);
    setState(next);
  };
  const { items } = question;
  const at = Math.min(state.at, items.length - 1);
  const item = items[at];
  if (!item) return null;
  const go = (answers: (string | null | undefined)[]) => {
    if (timer.current) return;
    // Kept until the Mac takes it: a refused round comes back as it was sent.
    keep({ ...state, answers });
    void send(session!, question, ["answer", session!, question.id, "--answers", JSON.stringify(answers.map((each) => each ?? null))]).then(() => {
      if (answering.get().get(session!)?.get(question.id)?.error === undefined) kept.delete(key);
    });
  };
  const answer = (given: string | null, picked = false) => {
    if (timer.current && !picked) return;
    const answers = items.map((_, i) => (i === at ? given : state.answers[i]));
    // On to the first one still open, or the round goes.
    const open = answers.findIndex((each) => each === undefined);
    if (open >= 0) return keep({ at: open, answers, ...restored(items[open]!, null) });
    go(answers);
  };
  const answered = state.answers.filter((each) => each !== undefined).length;
  // Back to any question answered so far, or on to the first one still open.
  const reachable = (to: number) => to >= 0 && to < items.length && to <= answered;
  const page = (to: number) => !timer.current && reachable(to) && keep({ ...state, at: to, ...restored(items[to]!, state.answers[to] ?? null) });
  const pick = (n: number) => {
    if (timer.current) return;
    if (item.multiSelect) return keep({ ...state, marked: state.marked.includes(n) ? state.marked.filter((m) => m !== n) : [...state.marked, n].sort((a, b) => a - b) });
    setChosen(n);
    const label = item.options[n]!.label;
    timer.current = setTimeout(() => {
      timer.current = null;
      setChosen(null);
      latest.current(label);
    }, COMMIT_MS);
  };
  // The timer answers with the card as it is then, not as it was when picked.
  latest.current = (given) => answer(given, true);
  const typed = state.typed.trim();
  const ready = typed !== "" || state.marked.length > 0;
  const last = items.every((_, i) => i === at || state.answers[i] !== undefined);
  const pickable = item.options.length > 0;
  return (
    <View style={st.card} accessibilityLabel="Question">
      <View style={st.question}>
        <View style={[st.shrink, { flex: 1, gap: space(1) }]} accessibilityLiveRegion="polite">
          {question.title ? <Text style={st.kind}><CodeSpans text={question.title} /></Text> : null}
          <Title><CodeSpans text={item.text} /></Title>
        </View>
        {items.length > 1 && <StepCounter noun="question" at={at} count={items.length} canBack={reachable(at - 1)} canForward={reachable(at + 1)} onStep={(by) => page(at + by)} />}
        {session && !question.held && (
          <Pressable accessibilityRole="button" accessibilityLabel="Skip" onPress={() => go(items.map((_, i) => state.answers[i] ?? null))} hitSlop={(touch - spacing.controlXs) / 2} style={st.close}>
            <X className="size-icon-md text-toolbar-foreground" />
          </Pressable>
        )}
      </View>
      <View style={st.options}>
        {item.options.map((option, n) => {
          const marked = n === chosen || (item.multiSelect && state.marked.includes(n));
          return (
            <View key={option.label} style={st.optionRow}>
              <Pressable
                onPress={session ? () => pick(n) : undefined}
                accessibilityRole={session ? (item.multiSelect ? "checkbox" : "radio") : undefined}
                accessibilityLabel={option.label.replaceAll("`", "")}
                accessibilityState={{ checked: marked }}
                style={({ pressed }) => [st.option, pressed && { backgroundColor: color.fillSubtle }]}
              >
                <Marker chosen={marked}>{n + 1}</Marker>
                <View style={[st.shrink, { flex: 1, gap: space(0.5) }]}>
                  <View style={st.labelRow}>
                    <Text style={st.label}><CodeSpans text={option.label} /></Text>
                    {item.recommended === n ? <View style={st.badge}><Text style={st.badgeText}>Recommended</Text></View> : null}
                  </View>
                  {option.description ? <Text style={st.description}><CodeSpans text={option.description} /></Text> : null}
                </View>
              </Pressable>
              <Shot shot={option.shot} label={[option.letter, option.name].filter(Boolean).join(" · ") || option.label} />
            </View>
          );
        })}
        {session && !question.held && (
          <FreeText marker={pickable}>
            <TextInput style={st.field} value={state.typed} onChangeText={(t) => keep({ ...state, typed: t })} placeholder={pickable ? "No, and tell the agent what to do differently" : "Type here"} placeholderTextColor={color.placeholder} multiline accessibilityLabel="Your answer" />
            <Action
              title={!ready ? "Skip" : last ? "Submit" : "Next"}
              primary={ready}
              medium
              onPress={() => answer(typed || (state.marked.length ? state.marked.map((m) => item.options[m]!.label).join(", ") : null))}
            />
          </FreeText>
        )}
      </View>
      <Problem error={error} onDismiss={onDismiss} style={{ paddingBottom: space(2) }} />
      {!session ? <OnMac /> : null}
    </View>
  );
}

/**
 * A mockup answer's picture, beside its row: Rust gives it as the desktop's `/attachment/<owner>/<id>` address, read here
 * through the phone's attachment reader. Any other address draws nothing, as before.
 */
function Shot({ shot, label }: { shot?: string | null; label: string }) {
  const [, owner, id] = /^\/attachment\/([^/?#]+)\/([^/?#]+)/.exec(shot ?? "") ?? [];
  if (!owner || !id) return null;
  return <ThreadImage owner={decodeURIComponent(owner)} attachment={decodeURIComponent(id)} label={label} style={st.shot} />;
}

/** A question gone back to shows its answer as given: its marks, or its own words (a picked single answer shows as words too, so Next keeps it). */
function restored(item: PendingQuestion["items"][number], given: string | null): { marked: number[]; typed: string } {
  if (given === null) return { marked: [], typed: "" };
  const labels = item.options.map((option) => option.label);
  const marks = item.multiSelect ? given.split(", ").map((label) => labels.indexOf(label)) : [];
  if (marks.length && marks.every((m) => m >= 0)) return { marked: marks, typed: "" };
  return { marked: [], typed: given };
}

/** The question the card asks, and a muted line under it: the desktop's ActionCardTitle. */
function Title({ children, detail }: { children: ReactNode; detail?: string }) {
  return (
    <View style={{ gap: space(0.5) }}>
      <Text style={st.title} accessibilityRole="header" selectable>{children}</Text>
      {detail ? <Text style={st.detail} selectable><CodeSpans text={detail} /></Text> : null}
    </View>
  );
}

/** An answer's 20px square, the desktop's Marker: its number, or a dot once picked or marked. */
function Marker({ chosen, children }: { chosen: boolean; children: number }) {
  return (
    <View accessible={false} style={[st.marker, { borderColor: chosen ? color.foreground : color.marker }]}>
      {chosen ? <View style={st.dot} /> : <Text style={st.markerText}>{children}</Text>}
    </View>
  );
}

/** The desktop's ActionFreeText: ✎ (under numbered answers), the field, then its button. */
function FreeText({ marker = true, style, children }: { marker?: boolean; style?: object; children: ReactNode }) {
  return (
    <View style={[st.free, style]}>
      {marker && <View style={st.pencil}><Pencil className="size-icon-sm text-toolbar-foreground" /></View>}
      {children}
    </View>
  );
}

/** "‹ 1 of 3 ›": bare arrows around "n of m", the desktop's StepCounter. `noun` names the arrows ("Previous request"). */
function StepCounter({ noun, at, count, canBack, canForward, onStep }: { noun: string; at: number; count: number; canBack: boolean; canForward: boolean; onStep: (step: -1 | 1) => void }) {
  const arrow = (step: -1 | 1, can: boolean) => (
    <Pressable accessibilityRole="button" accessibilityLabel={`${step < 0 ? "Previous" : "Next"} ${noun}`} accessibilityState={{ disabled: !can }} disabled={!can} onPress={() => onStep(step)} hitSlop={space(3)} style={[st.arrow, !can && { opacity: opacity.disabled }, step < 0 && { transform: [{ rotate: "180deg" }] }]}>
      <ChevronRight className="size-icon-xs text-muted-foreground" />
    </Pressable>
  );
  return (
    <View style={st.counter}>
      {arrow(-1, canBack)}
      <Text style={st.counterText}>{at + 1} of {count}</Text>
      {arrow(1, canForward)}
    </View>
  );
}

/** A card's error, and Dismiss beside it when nothing waits on it any more. */
function Problem({ error, onDismiss, style }: { error?: string | null; onDismiss?: () => void; style?: object }) {
  if (!error) return null;
  return (
    <View style={[st.problem, style]}>
      <Text style={[text.xs, { color: color.destructive, flexShrink: 1 }]} accessibilityRole="alert">{error}</Text>
      {onDismiss && (
        <Pressable accessibilityRole="button" onPress={onDismiss} hitSlop={8}>
          <Text style={[text.xs, { color: color.link }]}>Dismiss</Text>
        </Pressable>
      )}
    </View>
  );
}

/** A button's look on a card, the desktop's actionButton: a capsule, the primary filled, the other outlined. */
function Action({ title, onPress, primary = false, medium = false }: { title: string; onPress: () => void; primary?: boolean; medium?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={(touch - spacing.controlSm) / 2} style={({ pressed }) => [st.action, primary ? st.primary : st.outline, pressed && { transform: [{ scale: 0.97 }] }]}>
      <Text style={[st.actionText, { color: primary ? color.composer : color.foreground }, medium && { fontWeight: fontWeight.medium }]}>{title}</Text>
    </Pressable>
  );
}

const OnMac = () => <Text style={st.onMac}>Answer on your Mac</Text>;

const st = StyleSheet.create({
  cards: { gap: space(3), paddingTop: space(6) },
  // The approval in the composer's place; a question on the composer's rail.
  slot: { borderRadius: radius.composer, backgroundColor: color.composer },
  rail: { borderRadius: radius.overlay, borderWidth: 1, borderColor: color.border, backgroundColor: color.codeSurface, overflow: "hidden" },
  card: { flexDirection: "column" },
  head: { gap: space(2), paddingHorizontal: space(4), paddingTop: space(3.5), paddingBottom: space(2.5) },
  kindRow: { flexDirection: "row", alignItems: "center", gap: space(2) },
  kind: { ...text.code, lineHeight: space(5), color: color.cardKind },
  shrink: { flexShrink: 1, minWidth: 0 },
  end: { marginLeft: "auto" },
  title: { ...text.sm, lineHeight: space(5), fontWeight: fontWeight.medium, color: color.foreground },
  detail: { ...text.code, color: color.toolbarForeground },
  question: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space(2), paddingLeft: space(4), paddingRight: space(3), paddingTop: space(4), paddingBottom: space(2) },
  close: { width: spacing.controlXs, height: spacing.controlXs, alignItems: "center", justifyContent: "center", borderRadius: radius.control, marginTop: -space(0.5) },
  options: { gap: space(1), paddingHorizontal: space(2), paddingTop: space(1), paddingBottom: space(2) },
  optionRow: { flexDirection: "row", alignItems: "center", gap: space(2) },
  option: { flex: 1, flexDirection: "row", alignItems: "center", gap: space(2), minHeight: space(8), borderRadius: radius.surface, paddingHorizontal: space(2), paddingVertical: space(1.5) },
  labelRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space(1.5) },
  label: { ...text.code, fontWeight: fontWeight.medium, color: color.foreground, flexShrink: 1 },
  description: { ...text.code, color: color.toolbarForeground },
  badge: { height: space(5), justifyContent: "center", borderRadius: radius.capsule, backgroundColor: color.muted, paddingHorizontal: space(2) },
  badgeText: { ...text.xs, fontWeight: fontWeight.medium, color: color.foreground },
  shot: { width: space(24), height: space(16), borderRadius: radius.control, borderWidth: 1, borderColor: color.border, backgroundColor: color.muted },
  marker: { width: space(5), height: space(5), alignSelf: "flex-start", alignItems: "center", justifyContent: "center", borderRadius: radius.sm, borderWidth: 1 },
  markerText: { ...text.xs, lineHeight: text.xs.fontSize, fontWeight: fontWeight.medium, color: color.markerForeground },
  dot: { width: space(1.5), height: space(1.5), borderRadius: radius.capsule, backgroundColor: color.foreground },
  free: { flexDirection: "row", alignItems: "flex-start", gap: space(2), minHeight: space(8), borderRadius: radius.sheet, paddingHorizontal: space(2), paddingVertical: space(1.5) },
  pencil: { width: space(5), height: space(5), alignItems: "center", justifyContent: "center" },
  field: { ...text.code, flex: 1, color: color.foreground, padding: 0, maxHeight: space(30) },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space(2), paddingHorizontal: space(4), paddingTop: space(2), paddingBottom: space(4) },
  // The desktop's narrow card: the field on its own row above the buttons.
  reason: { marginLeft: -space(2), flexBasis: "100%" },
  buttons: { marginLeft: "auto", flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center", gap: space(2) },
  action: { height: spacing.controlSm, flexDirection: "row", alignItems: "center", gap: space(1), borderRadius: radius.capsule, borderWidth: 1, borderColor: color.fill, paddingHorizontal: space(2) },
  primary: { backgroundColor: color.foreground },
  outline: { backgroundColor: color.actionWash },
  actionText: { ...text.code, lineHeight: space(4.5) },
  counter: { flexDirection: "row", alignItems: "center", gap: space(0.5), height: space(6) },
  counterText: { ...text.xs, fontVariant: ["tabular-nums"], color: color.mutedForeground },
  arrow: { padding: space(0.5), borderRadius: radius.control },
  more: { flexDirection: "row", alignItems: "flex-start" },
  moreText: { ...text.xs, flex: 1, color: color.toolbarForeground, paddingHorizontal: space(4), paddingBottom: space(3) },
  problem: { flexDirection: "row", alignItems: "center", gap: space(1.5), paddingHorizontal: space(4) },
  onMac: { ...text.sm, color: color.mutedForeground, paddingHorizontal: space(4), paddingBottom: space(4) },
});
