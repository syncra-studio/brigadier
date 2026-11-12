import { SetupRow } from "../src/components/thread/setup";
import type { Setup, SetupStep } from "../src/thread/item";
import { Row, Section, State } from "./parts";

const WORKTREE: SetupStep = { kind: "worktree", state: "done", branch: "brigadier/session", base: "main", error: null };
const SCRIPT: SetupStep = { kind: "setupScript", state: "done", error: null };
const CLI: SetupStep = { kind: "cli", state: "done", cli: "Example CLI", error: null };
const DONE: Setup = { state: "done", before: null, steps: [WORKTREE, SCRIPT, CLI] };
const STARTS: Setup[] = [
  { ...DONE, state: "running", steps: [{ ...WORKTREE, state: "running" }] },
  { ...DONE, state: "running", steps: [WORKTREE, { ...SCRIPT, state: "running" }] },
  { ...DONE, state: "running", steps: [WORKTREE, SCRIPT, { ...CLI, state: "running" }] },
  DONE,
];
const FAILED: Setup[] = [
  { ...DONE, state: "failed", steps: [{ ...WORKTREE, state: "failed", error: "The worktree folder already exists." }] },
  { ...DONE, state: "failed", steps: [WORKTREE, { ...SCRIPT, state: "failed", code: 1, error: "Could not install dependencies." }, CLI] },
  { ...DONE, steps: [WORKTREE, SCRIPT, { ...CLI, state: "failed", error: "The executable could not be found." }] },
];

export function SetupGallery({ tick }: { tick: number }) {
  const live = STARTS[Math.floor(tick / 3) % STARTS.length]!;
  return (
    <Section title="Thread · worktree setup">
      <Row name="creating · script · CLI · done · failures · live">
        {STARTS.map((setup, index) => (
          <State key={index} label={["creating", "script", "CLI", "done"][index]!}>
            <SetupRow keep={`setup-state-${index}`} setup={setup} />
          </State>
        ))}
        {FAILED.map((setup, index) => (
          <State key={index} label={["worktree failed", "script failed", "CLI failed · worktree made"][index]!}>
            <SetupRow keep={`setup-failed-${index}`} setup={setup} />
          </State>
        ))}
        <State label="live · opens then folds">
          <SetupRow key={`${Math.floor(tick / 12)}:${live.state}`} keep={`setup-live-${Math.floor(tick / 12)}`} setup={live} />
        </State>
      </Row>
    </Section>
  );
}
