// Onboarding's Agents, Git and Projects steps in each state, a window's size each [D616, D617]. The agents are the real
// ones, by their adapters' marks, so their surfaces show as they will.
import type { ReactNode } from "react";

import { AgentCard, TestFailed, type TestFailure } from "../src/onboarding/agents";
import type { Agent } from "../src/onboarding/api";
import { type Forge, ForgeCard, GIT_LINE } from "../src/onboarding/git";
import { type Step, StepFooter, StepHeader, TopBar } from "../src/onboarding/parts";
import { ProjectsStep } from "../src/onboarding/projects";
import type { GitHub, Source } from "../src/projects/store";
import claudeMark from "../../../crates/core/src/adapters/claude/claude.svg?raw";
import codexMark from "../../../crates/core/src/adapters/codex/codex.svg?raw";
import opencodeMark from "../../../crates/core/src/adapters/opencode/opencode.svg?raw";
import { Row, Section, State } from "./parts";

const noop = () => {};
const MODELS = [{ id: "default", local: false }];
const BASE = { install: true, enabled: true, update: null, models_off: [], setup: null, version: "1.0.0" } satisfies Partial<Agent>;
const CLAUDE: Agent = { ...BASE, name: "claude", label: "Claude Code", sign_in: "Sign in", mark: claudeMark, brand: "claude", docs: "https://code.claude.com/docs", path: "/usr/local/bin/claude", signed_in: true, how: "Claude account", plan: "max", models: MODELS };
const CODEX: Agent = { ...BASE, name: "codex", label: "Codex", sign_in: "Sign in", mark: codexMark, brand: "codex", docs: "https://developers.openai.com/codex/cli", path: "/usr/local/bin/codex", signed_in: true, how: "ChatGPT account", models: MODELS };
const OPENCODE: Agent = { ...BASE, name: "opencode", label: "OpenCode", sign_in: "Sign in", mark: opencodeMark, brand: "opencode", docs: "https://opencode.ai/docs", path: null };
const run = (action: "install" | "sign-in", extra: Partial<NonNullable<Agent["setup"]>> = {}) => ({ id: "1", action, running: true, code: null, signal: null, code_page: null, reason: null, ...extra });

const SIGNED_OUT: Agent = { ...CODEX, signed_in: false, how: null, models: [] };
const SIGNING_IN: Agent = { ...SIGNED_OUT, setup: run("sign-in", { code_page: "https://auth.example.com/device", device_code: "WXYZ-1234" }) };
const INSTALLING: Agent = { ...OPENCODE, setup: run("install") };
const FAILURE: TestFailure = { label: "Codex", reason: "Your access token could not be refreshed. Please log out and sign in again.", login: "codex login" };

/** A window's size, with the strip along its top. */
function Window({ step, children }: { step: Step; children: ReactNode }) {
  return (
    <div className="relative flex h-205 w-320 flex-col overflow-hidden rounded-surface border border-border bg-background">
      <TopBar step={step} reached={3} onStep={noop} />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

function Agents({ agents, testing = false, failed = [], line }: { agents: Agent[]; testing?: boolean; failed?: TestFailure[]; line: string }) {
  const ready = agents.filter((agent) => agent.models?.length && !failed.some((each) => each.label === agent.label)).length;
  return (
    <Window step="agents">
      <div className="flex min-h-0 flex-1 flex-col">
        <StepHeader title="Connect your agents" description={line} />
        <div className="mt-12 min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <div className="mx-auto flex w-full max-w-onboarding flex-col gap-3">
            <ul className="onboarding-agent-grid">
              {agents.map((agent) => (
                <AgentCard
                  key={agent.name}
                  agent={agent}
                  online
                  starting={false}
                  retrying={false}
                  testing={testing && Boolean(agent.models?.length)}
                  failed={failed.find((each) => each.label === agent.label)?.reason}
                  onAction={noop}
                  onCancel={noop}
                  onRetry={noop}
                />
              ))}
            </ul>
            <TestFailed failures={failed} />
            <p className="text-xs text-setup-hint">You can connect more accounts anytime in Settings.</p>
          </div>
        </div>
        <StepFooter
          onBack={noop}
          count={testing ? "Sending a test prompt…" : `${ready} of ${agents.length} connected`}
          primary={{ label: "Continue", onClick: noop, busy: testing, disabled: ready === 0 }}
        />
      </div>
    </Window>
  );
}

const forge = (name: Forge["name"], extra: Partial<Forge> = {}): Forge => ({
  name,
  label: name === "github" ? "GitHub" : "GitLab",
  cli: true,
  logins: [],
  docs: name === "github" ? "https://cli.github.com" : "https://gitlab.com/gitlab-org/cli",
  setup: null,
  ...extra,
});

function Git({ forges }: { forges: Forge[] }) {
  const connected = forges.filter((each) => each.logins.length > 0);
  return (
    <Window step="git">
      <div className="flex min-h-0 flex-1 flex-col">
        <StepHeader title="Connect GitHub or GitLab" description={GIT_LINE} />
        <div className="mt-12 min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <ul className="onboarding-agent-grid mx-auto w-full max-w-onboarding">
            {forges.map((each) => (
              <ForgeCard key={each.name} forge={each} online starting={false} failed={undefined} onConnect={noop} onCancel={noop} />
            ))}
          </ul>
        </div>
        <StepFooter
          onBack={noop}
          count={connected.length ? `${connected.map((each) => each.label).join(" and ")} connected` : undefined}
          primary={{ label: connected.length ? "Continue" : "Skip for now", onClick: noop }}
        />
      </div>
    </Window>
  );
}

const never = () => new Promise<never>(noop);
const repo = (name: string, account: string) => ({ name, description: null, private: false, account });
// Two signed-in accounts: sam-example (and its org) and sam-at-work [D625].
const REPOS = [
  repo("example-org/weather-bot", "sam-example"),
  repo("sam-example/notes", "sam-example"),
  repo("acme-corp/billing", "sam-at-work"),
  repo("example-org/api", "sam-example"),
  repo("sam-example/site", "sam-example"),
  repo("acme-corp/design-system", "sam-at-work"),
  repo("sam-at-work/dotfiles", "sam-at-work"),
];
const source = (history: string[], github: GitHub = { repos: REPOS }): Source => ({
  history: async () => ({ found: history, parent: "~/Development/" }),
  check: never,
  add: never,
  clone: never,
  pick: never,
  github: async () => github,
});
const HISTORY = ["/Users/sam/Development/weather-bot", "/Users/sam/Development/notes", "/Users/sam/code/site", "/Users/sam/code/api"];

function Projects({ label, from, start }: { label: string; from: Source; start: "clone" | "folder" | "new" }) {
  return (
    <State label={label}>
      <Window step="projects">
        <ProjectsStep source={from} offline={false} onBack={noop} start={start} />
      </Window>
    </State>
  );
}

export function OnboardingGallery() {
  return (
    <Section title="Onboarding › Agents, Git, Projects">
      <Row name="Agents">
        <State label="connected · not signed in · not installed">
          <Agents agents={[CLAUDE, SIGNED_OUT, OPENCODE]} line="Claude Code is ready. Connect any others you use, or start right away." />
        </State>
        <State label="signing in (hover: Cancel) · installing">
          <Agents agents={[CLAUDE, SIGNING_IN, INSTALLING]} line="Claude Code is ready. Connect any others you use, or start right away." />
        </State>
        <State label="Continue: the test prompt running">
          <Agents agents={[CLAUDE, CODEX, OPENCODE]} testing line="Claude Code and Codex are ready. Connect any others you use, or start right away." />
        </State>
        <State label="test failed: back to Sign in, what to do under the cards">
          <Agents agents={[CLAUDE, CODEX, OPENCODE]} failed={[FAILURE]} line="Claude Code is ready. Connect any others you use, or start right away." />
        </State>
      </Row>
      <Row name="Git">
        <State label="connected">
          <Git forges={[forge("github", { logins: ["sam-example", "sam-at-work"] }), forge("gitlab")]} />
        </State>
        <State label="not connected · its CLI missing">
          <Git forges={[forge("github"), forge("gitlab", { cli: false })]} />
        </State>
        <State label="connecting (hover: Cancel)">
          <Git forges={[forge("github", { setup: run("sign-in", { code_page: "https://github.com/login/device", device_code: "A1B2-C3D4" }) }), forge("gitlab")]} />
        </State>
      </Row>
      <Row name="Projects">
        <Projects label="Clone · two accounts' repositories" from={source(HISTORY)} start="clone" />
        <Projects label="Clone · one picked" from={source(HISTORY)} start="clone" />
        <Projects label="Clone · GitHub not connected" from={source(HISTORY, { gh: "signed-out" })} start="clone" />
        <Projects label="Clone · no gh" from={source(HISTORY, { gh: "missing" })} start="clone" />
        <Projects label="Existing folder" from={source(HISTORY)} start="folder" />
        <Projects label="Existing folder · nothing in the history" from={source([])} start="folder" />
        <Projects label="New" from={source(HISTORY)} start="new" />
      </Row>
    </Section>
  );
}
