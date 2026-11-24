import { useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "../components/button";
import { type ApprovalDecision, ApprovalSlot, forgetReasons, MoreWaiting, type PendingApproval } from "../components/composer/approval";
import { StepCounter } from "../components/composer/decision-parts";
import { forgetQuestions, type Given, type PendingQuestion, QuestionCard } from "../components/composer/question";
import { RailItem, WaitingRow } from "../components/composer/rail";
import { ask, threadSource, useDaemon } from "../daemon";
import { useMockup } from "../mockup/live";
import { openTab } from "../shell/tab-store";
import type { Item, Session } from "../thread/item";
import type { Source } from "../thread/thread";
import { useWorkers } from "../workers/live";
import type { Runner } from "./composer";
import { saidDraft } from "./files";

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
  answers?: Given[];
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
      if (item.kind === "question") {
        let images = 0;
        const said = (answer.answers ?? []).map((each) => {
          if (each === null || typeof each === "string") return { text: each, files: null };
          const one = saidDraft(session.id, each, images);
          images = one.images;
          return one;
        });
        const answers = said.map((each) => each.text);
        return { ...item, answer: answers.filter((each) => each !== null).join("\n"), answers, files: said.map((each) => each.files), withdrawn: false };
      }
      return item;
    }),
    approvals: session.approvals?.filter((each) => !hidden(each.id)),
    questions: session.questions?.filter((each) => !hidden(each.id)),
  };
}

let answeringMemo: { from: Session | null; mine: ReadonlyMap<string, Answer> | undefined; out: Session | null } = { from: null, mine: undefined, out: null };
/** The open thread with the answers on their way already in it. */
export const answeringSource: Omit<Source, "older"> & Pick<typeof threadSource, "older" | "newer" | "latest" | "jump" | "findOlder"> = {
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
    if (from !== answeringMemo.from || mine !== answeringMemo.mine) answeringMemo = { from, mine, out: from && overlay(from, mine) };
    return answeringMemo.out;
  },
  older: () => threadSource.older(),
  newer: () => threadSource.newer(),
  latest: () => threadSource.latest(),
  jump: (n) => threadSource.jump(n),
  findOlder: (query, limit) => threadSource.findOlder(query, limit),
};

/** Another snapshot (a worker's tab) with its answers on their way in it, as `answeringSource` is the open thread's [D305]. */
export function withAnswers(from: Source): Source & { raw(): Session | null } {
  let memo: typeof answeringMemo = { from: null, mine: undefined, out: null };
  return {
    subscribe(listener) {
      const off = from.subscribe(listener);
      const offMine = subscribe(listener);
      return () => {
        off();
        offMine();
      };
    },
    get() {
      const now = from.get();
      const mine = now ? answering.get(now.id) : undefined;
      if (now !== memo.from || mine !== memo.mine) memo = { from: now, mine, out: now && overlay(now, mine) };
      return memo.out;
    },
    raw: () => from.get(),
  };
}

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

/** A worker's approval on its parent's card: the worker answers it. */
type WorkerApproval = PendingApproval & { session: string };

/**
 * The approvals its workers wait on the user for (at Ask) [D126]: on the parent's own card, each naming its worker, as
 * the old app's. Rust's snapshot of each, asked again as its row changes.
 */
function useWorkerApprovals(owner: string): WorkerApproval[] {
  const asking = useWorkers(owner).filter((worker) => worker.kind === "needsYou");
  const rows = useDaemon().rows;
  const key = asking.map((worker) => `${worker.id}:${rows?.find((row) => row.id === worker.id)?.updated}`).join(" ");
  const [found, setFound] = useState<ReadonlyMap<string, WorkerApproval[]>>(new Map());
  useEffect(() => {
    let live = true;
    setFound((was) => new Map([...was].filter(([wid]) => asking.some((worker) => worker.id === wid))));
    for (const worker of asking)
      ask({ op: "peek", session: worker.id }, (reply) => {
        const approvals: PendingApproval[] = reply.ok ? (reply.session.approvals ?? []) : [];
        if (live) setFound((was) => new Map(was).set(worker.id, approvals.map((each) => ({ ...each, agent: worker.name, session: worker.id }))));
      });
    return () => {
      live = false;
    };
  }, [key]);
  return [...found.values()].flat();
}

/** What waits on the user in this session: Rust's lists without the answers on their way, plus refused stale ones, and its workers' approvals. */
function useWaiting(id: string, source: Source) {
  const shown = useSyncExternalStore(source.subscribe, source.get);
  // All sessions' answers: a worker's, on this card, is under the worker's id.
  const all = useSyncExternalStore(subscribe, () => answering);
  const mine = all.get(id);
  const session = shown?.id === id ? shown : null;
  // Rust's own rows (the overlaid ones always show the answer): an entry goes once its row has moved on.
  const raw = (source as { raw?: () => Session | null }).raw?.() ?? threadSource.get();
  const workers = useWorkerApprovals(id).filter((each) => {
    const answer = all.get(each.session)?.get(each.id);
    return !answer || answer.error !== undefined;
  });
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
    const keep = new Set([...(raw.approvals ?? []), ...(raw.questions ?? []), ...workers].map((each) => each.id).concat([...(mine?.keys() ?? [])]));
    forgetReasons(id, keep);
    forgetQuestions(id, keep);
  });
  const listed = (list: { id: string }[] | undefined, each: Answer) => list?.some((one) => one.id === each.request.id) === true;
  // Refused, and nothing waits on it any more (the turn ended, it was answered elsewhere): stale.
  const stale = [...(mine?.values() ?? [])].filter((each) => each.error !== undefined && !listed("items" in each.request ? session?.questions : session?.approvals, each));
  // A plan its review holds, or its agent revises, has nothing to answer: what can be answered (its reviewer's own ask) shows first [D395, D401].
  const approvals: (PendingApproval | WorkerApproval)[] = [...(session?.approvals ?? []), ...stale.flatMap((each) => ("items" in each.request ? [] : [each.request])), ...workers].sort(
    (a, b) => Number(Boolean(a.review || a.revising)) - Number(Boolean(b.review || b.revising)),
  );
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
 * The approvals waiting [D199, D203, D317]: in the composer's place, the field kept hidden under it. Deny with what
 * to do instead [D192], Allow … for this session from Rust's grant structure [D65, D193], Allow once; nothing else
 * while one waits [D327]. A refusal's error is Rust's, kept with the answer.
 */
export function SessionApprovals({ id, run, source }: { id: string; run: Runner; source: Source }) {
  const { approvals, dismiss, error } = useWaiting(id, source);
  return (
    <ApprovalSlot
      session={id}
      approvals={approvals}
      dismiss={dismiss}
      error={error}
      onAnswer={(request, decision, reason) => {
        const found = approvals.find((each) => each.id === request);
        return found ? send(run, "session" in found ? found.session : id, { request: found, decision, reason, state: "sending" }) : Promise.resolve();
      }}
    />
  );
}

/** Whether an approval waits, so the composer gives it its place. */
export const useApprovalWaiting = (id: string, source: Source) => useWaiting(id, source).approvals.length > 0;

/**
 * The questions waiting, on the rail above the composer, one at a time, ‹ 1 of 2 › between them; Esc puts them aside
 * [D199, D207]. A mockup's card shows its variants' pictures as they are now, and Open brings its own tab to the front.
 */
export function SessionQuestions({ id, run, source, ...takes }: { id: string; run: Runner; source: Source; /** The agent that takes an answer's images, and whether its model can. */ backend?: string; images: boolean }) {
  const { questions, error, dismiss } = useWaiting(id, source);
  const [aside, setAside] = useState(false);
  // The card shown, by id, so another coming or going doesn't change it; where it was, for the one after it when it goes.
  const [shown, setShown] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  const found = questions.findIndex((each) => each.id === shown.id);
  const at = found >= 0 ? found : Math.min(shown.index, questions.length - 1);
  const question = questions[at];
  if (shown.id !== (question?.id ?? null)) setShown({ id: question?.id ?? null, index: Math.max(at, 0) });
  const mockup = question?.mockup;
  const drawn = useMockup(mockup?.worker ?? "")?.rounds[(mockup?.round ?? 0) - 1]?.variants;
  if (!question) return null;
  if (aside) return <WaitingRow count={questions.length} onShow={() => setAside(false)} />;
  const pictured = !drawn
    ? question
    : { ...question, items: question.items.map((item) => ({ ...item, options: item.options.map((option) => ({ ...option, shot: drawn.find((each) => each.letter === option.letter)?.shot })) })) };
  return (
    <RailItem variant="decision" label="Waiting for you">
      <QuestionCard
        key={question.id}
        session={id}
        run={run}
        {...takes}
        question={pictured}
        error={error(question.id)}
        dismiss={dismiss(question.id)}
        onAnswer={(answers) => send(run, id, { request: question, answers, state: "sending" })}
        onDismiss={() => setAside(true)}
        actions={
          mockup && (
            <Button size="xs" variant="outline" aria-label={`Open ${mockup.title}`} onClick={() => openTab(id, "mockup", mockup.worker)}>
              Open
            </Button>
          )
        }
        footer={
          questions.length > 1 && (
            <div className="flex items-start">
              <MoreWaiting more={questions.length - 1 - at} />
              <StepCounter
                noun="decision"
                at={at}
                count={questions.length}
                canBack={at > 0}
                canForward={at < questions.length - 1}
                onStep={(by) => setShown({ id: questions[at + by]?.id ?? null, index: at + by })}
                className="ms-auto pe-4 pb-3"
              />
            </div>
          )
        }
      />
    </RailItem>
  );
}
