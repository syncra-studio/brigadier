// The composer's question cards (slice 4b): every state, frozen, plus one live copy on the rail.
import { useState } from "react";

import { MoreWaiting } from "../src/components/composer/approval";
import { ComposerCard, ComposerFooter, ComposerTools, PlusButton } from "../src/components/composer/composer";
import { ComposerField } from "../src/components/composer/field";
import { type PendingQuestion, QuestionCard } from "../src/components/composer/question";
import { ComposerRail, RailItem, WaitingRow } from "../src/components/composer/rail";
import { SendButton } from "../src/components/composer/send-button";
import { QuestionRow } from "../src/components/thread/cards";
import { ModelPill } from "./composer";
import { Row, Section, State } from "./parts";

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
const ROUND = ask("round", [MANAGER, CHECKS, NAME], "Release setup");

const later = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

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

export function QuestionGallery() {
  return (
    <>
      <Section title="Question card">
        <Live />
      </Section>
      <Section title="A round's row in the thread">
        <Row name="count and the round's title">
          <State label="answered">
            <QuestionRow keep="d209-p" question={MANAGER.text} answer="pnpm" round={ROUND} answers={["pnpm", "Typecheck", "release"]} waiting={false} />
          </State>
        </Row>
      </Section>
    </>
  );
}
