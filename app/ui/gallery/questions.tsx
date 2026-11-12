// A question round's row in the thread (slice 4b); the question card itself is live in the composer.
import { QuestionRow } from "../src/components/thread/cards";
import { Row, Section, State } from "./parts";

const MANAGER = { text: "Which package manager should the scripts use?", options: [{ label: "pnpm" }, { label: "npm" }, { label: "yarn" }], recommended: null, multiSelect: false };
const CHECKS = { text: "Which checks should run before each push?", options: [{ label: "Typecheck" }, { label: "Lint" }, { label: "`scripts/limits`" }, { label: "Bundle check" }], recommended: null, multiSelect: true };
const NAME = { text: "What should the new command be called?", options: [], recommended: null, multiSelect: false };
const ROUND = { id: "round", title: "Release setup", items: [MANAGER, CHECKS, NAME] };

export function QuestionGallery() {
  return (
    <Section title="A round's row in the thread">
      <Row name="count and the round's title">
        <State label="answered">
          <QuestionRow keep="d209-p" question={MANAGER.text} answer="pnpm" round={ROUND} answers={["pnpm", "Typecheck", "release"]} waiting={false} />
        </State>
      </Row>
    </Section>
  );
}
