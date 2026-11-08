import { useEffect, useState, useSyncExternalStore } from "react";

import { type ApprovalDecision, ApprovalSlot, forgetReasons, MoreWaiting, type PendingApproval } from "../components/composer/approval";
import { forgetQuestions, type PendingQuestion, QuestionCard } from "../components/composer/question";
import { RailItem, WaitingRow } from "../components/composer/rail";
import { threadSource } from "../daemon";
import type { Item, Session } from "../thread/item";
import type { Source } from "../thread/thread";
import type { Runner } from "./composer";

/*
 * Answers to the agent's requests, shown at once [D30, D203]: the card goes and the thread row shows the answer, by
 * request id, until Rust's own row has it. One logged but not proven delivered stays hidden, its row Rust's, until
 * Rust's row moves on; it's never shown as delivered nor sent again [D222]. A refusal brings the card back with its
 * error; one Rust no longer lists (a stale request: the turn ended, it was answered elsewhere) gets Dismiss beside it.
 */
type Answer = {
  request: PendingApproval | PendingQuestion;
  decision?: ApprovalDecision;
  /** What to do instead, typed with a deny [D192]. */
  reason?: string;
  answers?: (string | null)[];
  /** How far it got: on its way, delivered, or logged without proof it was delivered. */
  state: "sending" | "delivered" | "logged";
  /** Rust refused it; kept, with the card, until answered again or (once Rust no longer lists it) dismissed. */
  error?: string;
};
let answering = new Map<string, ReadonlyMap<string, Answer>>();
const listeners = new Set<() => void>();
function setAnswer(session: string, request: string, answer: Answer | undefined): void {
  const mine = new Map(answering.get(session));
  if (answer) mine.set(request, answer);
  else mine.delete(request);
  answering = new Map(answering).set(session, mine);
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const requestOf = (item: Item) => (item.kind === "approval" ? item.request.id : item.kind === "question" ? item.request?.id : undefined);
/** Rust's row shows an answer. */
const decided = (item: Item) => (item.kind === "approval" ? item.decision === "approved" || item.decision === "denied" : item.kind === "question" && item.answer !== null && !item.withdrawn);
/** Rust's row no longer waits: answered or withdrawn. */
const moved = (item: Item) => (item.kind === "approval" ? item.decision !== null : item.kind === "question" && (item.answer !== null || item.withdrawn === true));

function overlay(session: Session, mine: ReadonlyMap<string, Answer> | undefined): Session {
  if (!mine?.size) return session;
  const hidden = (id: string) => mine.has(id) && mine.get(id)?.error === undefined;
  return {
    ...session,
    items: session.items.map((item) => {
      const id = requestOf(item);
      const answer = id === undefined ? undefined : mine.get(id);
      if (!answer || answer.error !== undefined || answer.state === "logged" || decided(item)) return item;
      if (item.kind === "approval") return { ...item, decision: answer.decision === "deny" ? "denied" : "approved" };
      if (item.kind === "question") return { ...item, answer: (answer.answers ?? []).filter((each) => each !== null).join("\n"), answers: answer.answers, withdrawn: false };
      return item;
    }),
    approvals: session.approvals?.filter((each) => !hidden(each.id)),
    questions: session.questions?.filter((each) => !hidden(each.id)),
  };
}

let memo: { from: Session | null; mine: ReadonlyMap<string, Answer> | undefined; out: Session | null } = { from: null, mine: undefined, out: null };
/** The open thread with the answers on their way already in it. */
export const answeringSource: Source = {
  subscribe(listener) {
    const off = threadSource.subscribe(listener);
    const offMine = subscribe(listener);
    return () => {
      off();
      offMine();
    };
  },
  get() {
    const from = threadSource.get();
    const mine = from ? answering.get(from.id) : undefined;
    if (from !== memo.from || mine !== memo.mine) memo = { from, mine, out: from && overlay(from, mine) };
    return memo.out;
  },
  older: () => threadSource.older?.(),
};

const WHY: Record<string, string> = {
  answered: "Already answered",
  uncertain: "Your earlier answer may not have reached the agent",
  not_running: "The session that asked has ended",
  disconnected: "Brigadier isn't running",
};
function refusal(reply: Record<string, any>): string {
  if (reply.error === "not_pending") return WHY[reply.why] ?? (reply.why === "unknown" ? "Nothing is waiting for this answer" : "The agent stopped waiting for this");
  return WHY[reply.error] ?? String(reply.message ?? reply.error ?? "Refused");
}

/** Sends an answer through Rust (`brigadier answer`); the promise fails with a refusal's words, after the card was already hidden. */
function send(run: Runner, session: string, answer: Answer): Promise<void> {
  const { request, decision, reason, answers } = answer;
  setAnswer(session, request.id, answer);
  const args = answers ? ["--answers", JSON.stringify(answers)] : [decision!, ...(reason ? ["--reason", reason] : [])];
  return run(["answer", session, request.id, ...args]).then((reply) => {
    if (reply.ok) return setAnswer(session, request.id, { ...answer, state: reply.result === "delivered" ? "delivered" : "logged" });
    const error = refusal(reply);
    setAnswer(session, request.id, { ...answer, error });
    throw new Error(error);
  });
}

/** What waits on the user in this session: Rust's lists without the answers on their way, plus refused stale ones. */
function useWaiting(id: string, source: Source) {
  const shown = useSyncExternalStore(source.subscribe, source.get);
  const mine = useSyncExternalStore(subscribe, () => answering.get(id));
  const session = shown?.id === id ? shown : null;
  // Rust's own rows (the overlaid ones always show the answer): an entry goes once its row has moved on.
  const raw = threadSource.get();
  useEffect(() => {
    if (raw?.id !== id) return;
    for (const item of raw.items) {
      const request = requestOf(item);
      const answer = request === undefined ? undefined : mine?.get(request);
      // One on its way waits for its reply (Rust's row reads withdrawn between log and delivery); a refused one for
      // another answer or its Dismiss.
      if (!answer || answer.error !== undefined || answer.state === "sending") continue;
      const done = answer.state === "delivered" ? decided(item) : moved(item);
      if (done) setAnswer(id, request!, undefined);
    }
    // The cards' kept text goes with requests that no longer wait, so nothing outlives its request.
    const keep = new Set([...(raw.approvals ?? []), ...(raw.questions ?? [])].map((each) => each.id).concat([...(mine?.keys() ?? [])]));
    forgetReasons(id, keep);
    forgetQuestions(id, keep);
  });
  const listed = (list: { id: string }[] | undefined, each: Answer) => list?.some((one) => one.id === each.request.id) === true;
  // Refused, and nothing waits on it any more (the turn ended, it was answered elsewhere): stale.
  const stale = [...(mine?.values() ?? [])].filter((each) => each.error !== undefined && !listed("items" in each.request ? session?.questions : session?.approvals, each));
  const approvals = [...(session?.approvals ?? []), ...stale.flatMap((each) => ("items" in each.request ? [] : [each.request]))];
  const questions = [...(session?.questions ?? []), ...stale.flatMap((each) => ("items" in each.request ? [each.request] : []))];
  return {
    approvals,
    questions,
    error: (request: string) => mine?.get(request)?.error ?? null,
    /** A stale card's Dismiss (PROPOSED): nothing waits on it, so it only goes. */
    dismiss: (request: string) => (stale.some((each) => each.request.id === request) ? () => setAnswer(id, request, undefined) : undefined),
  };
}

/**
 * The approvals waiting [D199, D203]: in the composer's place (`placement` "composer", the field kept hidden under
 * it), or on the rail after Reply…. Deny with what to do instead [D192], Allow … for this session from Rust's grant
 * structure [D65, D193], Allow once. Mounted while none waits, so a refusal that comes later finds its card's error.
 */
export function SessionApprovals({ id, run, source, placement, onReply }: { id: string; run: Runner; source: Source; placement: "composer" | "rail"; onReply?: () => void }) {
  const { approvals, dismiss } = useWaiting(id, source);
  return (
    <ApprovalSlot
      session={id}
      approvals={approvals}
      placement={placement}
      onReply={onReply}
      dismiss={dismiss}
      onAnswer={(request, decision, reason) => {
        const found = approvals.find((each) => each.id === request);
        return found ? send(run, id, { request: found, decision, reason, state: "sending" }) : Promise.resolve();
      }}
    />
  );
}

/** Whether an approval waits, so the composer gives it its place. */
export const useApprovalWaiting = (id: string, source: Source) => useWaiting(id, source).approvals.length > 0;

/** The questions waiting, on the rail above the composer, one at a time; Esc puts them aside [D199, D207]. */
export function SessionQuestions({ id, run, source }: { id: string; run: Runner; source: Source }) {
  const { questions, error, dismiss } = useWaiting(id, source);
  const [aside, setAside] = useState(false);
  const question = questions[0];
  if (!question) return null;
  if (aside) return <WaitingRow count={questions.length} onShow={() => setAside(false)} />;
  return (
    <RailItem variant="decision" label="Waiting for you">
      <QuestionCard
        key={question.id}
        session={id}
        question={question}
        error={error(question.id)}
        dismiss={dismiss(question.id)}
        onAnswer={(answers) => send(run, id, { request: question, answers, state: "sending" })}
        onDismiss={() => setAside(true)}
        footer={<MoreWaiting more={questions.length - 1} />}
      />
    </RailItem>
  );
}
