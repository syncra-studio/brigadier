// The composer's question cards (slice 4b): every state, frozen, plus one live copy on the rail.
import { type ReactNode, useEffect, useRef, useState } from "react";

import { MoreWaiting } from "../src/components/composer/approval";
import { ComposerCard, ComposerFooter, ComposerTools, PlusButton } from "../src/components/composer/composer";
import { ComposerField } from "../src/components/composer/field";
import { type PendingQuestion, QuestionCard } from "../src/components/composer/question";
import { ComposerRail, RailItem, WaitingRow } from "../src/components/composer/rail";
import { SendButton } from "../src/components/composer/send-button";
import { ApprovalRow, QuestionRow } from "../src/components/thread/cards";
import { ModelPill } from "./composer";
import { Row, State } from "./parts";

const MANAGER = { text: "Which package manager should the scripts use?", options: [{ label: "pnpm" }, { label: "npm" }, { label: "yarn" }], recommended: null, multiSelect: false };
const STORAGE = {
  text: "Where should the drafts be stored?",
  options: [
    { label: "In the session's folder", description: "Kept with `sessions/<id>/`, removed with the session." },
    { label: "In one shared file", description: "One `drafts.json` for every session." },
    { label: "Only in memory", description: "Gone when the app quits." },
  ],
  recommended: 0,
  multiSelect: false,
};
const CHECKS = { text: "Which checks should run before each push?", options: [{ label: "Typecheck" }, { label: "Lint" }, { label: "`scripts/limits`" }, { label: "Bundle check" }], recommended: null, multiSelect: true };
const NAME = { text: "What should the new command be called?", options: [], recommended: null, multiSelect: false };

const ask = (id: string, items: PendingQuestion["items"], title?: string): PendingQuestion => ({ id, title, items });

const never = () => new Promise<void>(() => {});
const refuse = () => Promise.reject(new Error("The session ended before the answer reached it"));
const later = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Does something to the card as it mounts (presses a key, clicks an answer, types), to hold a state still. */
function Act({ run, children }: { run: (card: HTMLElement) => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => run(box.current!.querySelector<HTMLElement>("[data-action=question]")!), []);
  return <div ref={box}>{children}</div>;
}
const key = (card: HTMLElement, name: string) => card.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
const click = (card: HTMLElement, selector: string, at = 0) => card.querySelectorAll<HTMLElement>(selector)[at]?.click();
/** A card as it waits on the rail. */
function Card({ question, onAnswer = () => later(600) }: { question: PendingQuestion; onAnswer?: (answers: (string | null)[]) => Promise<void> }) {
  return (
    <div className="w-reading">
      <ComposerRail>
        <RailItem variant="decision" label="Waiting for you">
          <QuestionCard question={question} onAnswer={onAnswer} onDismiss={() => {}} />
        </RailItem>
      </ComposerRail>
    </div>
  );
}

function Composer() {
  return (
    <ComposerCard>
      <ComposerField placeholder="Do anything" />
      <ComposerFooter>
        <ComposerTools>
          <PlusButton />
        </ComposerTools>
        <ModelPill />
        <SendButton empty running={false} canStop={false} onSend={() => {}} onStop={() => {}} />
      </ComposerFooter>
    </ComposerCard>
  );
}

/** A decided card's thread row, and the composer back in its place. */
function Decided({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-reading flex-col gap-3">
      {children}
      <Composer />
    </div>
  );
}

/** Questions coming, answered, put aside and shown again: Rust's stand-in takes each answer a moment later. */
function Live() {
  const [questions, setQuestions] = useState<PendingQuestion[]>([ask("l1", [STORAGE]), ask("l2", [MANAGER, CHECKS, NAME], "Release setup"), ask("l3", [CHECKS])]);
  const [aside, setAside] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const question = questions[0];
  const answer = async (answers: (string | null)[]) => {
    await later(500);
    setQuestions((list) => list.slice(1));
    setAnswered(true);
    setLog((lines) => [...lines.slice(-3), answers.map((each) => each ?? "(skipped)").join(" · ")]);
  };
  return (
    <div className="flex w-reading flex-col gap-3">
      <ol className="flex flex-col gap-1 text-sm text-muted-foreground">
        {log.map((line, at) => (
          <li key={at}>{line}</li>
        ))}
        <li>
          <button
            type="button"
            className="cursor-pointer text-link hover:underline"
            onClick={() => setQuestions((list) => [...list, ask(crypto.randomUUID(), [MANAGER])])}
          >
            One more question
          </button>
        </li>
      </ol>
      <div>
        <ComposerRail>
          {question && aside && <WaitingRow count={questions.length} onShow={() => setAside(false)} />}
          {question && !aside && (
            <RailItem variant="decision" label="Waiting for you">
              <QuestionCard key={question.id} question={question} onAnswer={answer} onDismiss={() => setAside(true)} stagger={answered} footer={<MoreWaiting more={questions.length - 1} />} />
            </RailItem>
          )}
        </ComposerRail>
        <Composer />
      </div>
    </div>
  );
}

export function QuestionRows() {
  return (
    <>
      <Row name="Question">
        <State label="Plain">
          <Card question={ask("q1", [MANAGER])} />
        </State>
        <State label="Recommended, with descriptions">
          <Card question={ask("q2", [STORAGE])} />
        </State>
        <State label="Lit (2, from the keyboard)">
          <Act run={(card) => key(card, "2")}>
            <Card question={ask("q3", [STORAGE])} />
          </Act>
        </State>
        <State label="The field alone">
          <Card question={ask("q4", [NAME])} />
        </State>
      </Row>
      <Row name="Answering">
        <State label="Multi-select, two marked">
          <Act
            run={(card) => {
              click(card, "[data-slot=action-option]", 0);
              // After the first mark has rendered.
              setTimeout(() => click(card, "[data-slot=action-option]", 2));
            }}
          >
            <Card question={ask("q5", [CHECKS])} />
          </Act>
        </State>
        <State label="A round: 2 of 3, after picking">
          <Act run={(card) => click(card, "[data-slot=action-option]")}>
            <Card question={ask("q7", [MANAGER, CHECKS, NAME], "Release setup")} />
          </Act>
        </State>
      </Row>
      <Row name="Sending, refused, put aside">
        <State label="Sending">
          <Act run={(card) => click(card, "button", 1)}>
            <Card question={ask("q8", [MANAGER])} onAnswer={never} />
          </Act>
        </State>
        <State label="Refused">
          <Act run={(card) => click(card, "button", 1)}>
            <Card question={ask("q9", [MANAGER])} onAnswer={refuse} />
          </Act>
        </State>
        <State label="Put aside (Esc): one click away">
          <div className="w-reading">
            <ComposerRail>
              <WaitingRow count={1} onShow={() => {}} />
            </ComposerRail>
            <Composer />
          </div>
        </State>
      </Row>
      <Row name="Once decided: the card goes, the thread keeps its row (open it)">
        <State label="An approval allowed">
          <Decided>
            <ApprovalRow keep="decided-a1" action="command" title="Run the type checker to see what broke" detail="pnpm typecheck" decision="approved" waiting={false} />
          </Decided>
        </State>
        <State label="An approval denied">
          <Decided>
            <ApprovalRow keep="decided-a2" action="edit" title="Allow editing these files?" detail="app/ui/src/theme.css" decision="denied" waiting={false} />
          </Decided>
        </State>
        <State label="A question answered">
          <Decided>
            <QuestionRow keep="decided-q1" question={STORAGE.text} answer="In the session's folder (Recommended)" waiting={false} />
          </Decided>
        </State>
      </Row>
      <Row name="Questions live (Esc puts one aside)">
        <Live />
      </Row>
    </>
  );
}
