// Home's new-session draft on Fake data [D160, D161]: each state frozen, the pickers held open, plus a live copy.
import { type ReactNode, useState } from "react";

import type { ModelChoice, ModelGroup } from "../src/components/composer/model-picker";
import type { RepoState } from "../src/home/branch";
import type { DraftProject, WorkIn } from "../src/home/pills";
import { type HomeProps, HomeView } from "../src/home/view";
import { LevelPill } from "./composer";
import { Held, Row, Section, State } from "./parts";

const noop = () => {};
const RING = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="5.5"/></svg>';

const PROJECTS: DraftProject[] = [
  { id: "p-todo", name: "todo-app" },
  { id: "p-invoice", name: "invoice-service" },
  { id: "p-tokens", name: "design-tokens" },
];
const GROUPS: ModelGroup[] = [
  { provider: "cloud", label: "Cloud agent", mark: RING, models: [{ id: "large", name: "Large model", efforts: ["low", "medium", "high"], defaultEffort: "medium" }] },
  { provider: "local", label: "Local models", mark: null, models: [{ id: "llama", name: "Local 8B", efforts: [] }] },
  { provider: "away", label: "Signed-out agent", mark: null, models: [], unavailable: "sign-in" },
];
const LARGE: ModelChoice = { provider: "cloud", model: "large", effort: "medium" };

const REPO: RepoState = {
  info: { current: "main", branches: ["main", "feat/invoices", "fix/rounding"], worktrees: [{ path: "/Users/you/code/todo-review", branch: "review" }] },
  loading: false,
  refresh: noop,
};

const BASE: HomeProps = {
  name: "Sam",
  level: <LevelPill />,
  projects: PROJECTS,
  project: PROJECTS[0]!,
  onProject: noop,
  onAddProject: noop,
  onNoProject: noop,
  workIn: "worktree",
  onWorkIn: noop,
  repo: REPO,
  base: null,
  onBase: noop,
  worktree: null,
  onWorktree: noop,
  groups: GROUPS,
  model: LARGE,
  onModel: noop,
  onSetUp: noop,
  offline: false,
  onSend: noop,
};

/** A window-sized frame for one Home. */
const Frame = ({ children }: { children: ReactNode }) => <div className="flex h-150 w-200 flex-col rounded-surface bg-background ring ring-border">{children}</div>;

function HeldHome({ picker }: { picker: NonNullable<HomeProps["held"]>["picker"] }) {
  return <Held className="flex h-150 w-200 flex-col rounded-surface bg-background ring ring-border">{(box) => <HomeView {...BASE} held={{ box, picker }} />}</Held>;
}

/** The live copy: picks change it, Send shows what would start. */
function LiveHome() {
  const [project, setProject] = useState<DraftProject>(PROJECTS[0]!);
  const [workIn, setWorkIn] = useState<WorkIn>("worktree");
  const [model, setModel] = useState(LARGE);
  const [sent, setSent] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <Frame>
        <HomeView
          {...BASE}
          project={project}
          onProject={(id) => setProject(PROJECTS.find((each) => each.id === id)!)}
          workIn={workIn}
          onWorkIn={setWorkIn}
          model={model}
          onModel={setModel}
          onSend={(text) => setSent(`start --project ${project.id}${workIn === "local" ? " --local" : ""} --backend ${model.provider} --model ${model.model} --text ${JSON.stringify(text)}`)}
        />
      </Frame>
      <p className="font-mono text-xs text-muted-foreground">{sent ?? "Send shows the start command here"}</p>
    </div>
  );
}

export function HomeGallery() {
  return (
    <Section title="Home: new-session draft">
      <Row name="States">
        <State label="Ready: last project, new worktree, a model">
          <Frame>
            <HomeView {...BASE} />
          </Frame>
        </State>
        <State label="No project: a chat">
          <Frame>
            <HomeView {...BASE} projects={[]} project={null} />
          </Frame>
        </State>
        <State label="Local checkout, no name, models loading">
          <Frame>
            <HomeView {...BASE} name="" workIn="local" groups={null} model={null} />
          </Frame>
        </State>
        <State label="No model available">
          <Frame>
            <HomeView {...BASE} groups={GROUPS.slice(2)} model={null} />
          </Frame>
        </State>
        <State label="Models can't be listed">
          <Frame>
            <HomeView {...BASE} modelError="Couldn't check the agents: the daemon isn't running" />
          </Frame>
        </State>
        <State label="Offline">
          <Frame>
            <HomeView {...BASE} offline />
          </Frame>
        </State>
      </Row>
      <Row name="Pickers open">
        <State label="Project pill">
          <HeldHome picker="project" />
        </State>
        <State label="Work in">
          <HeldHome picker="workIn" />
        </State>
        <State label="The heading's project">
          <HeldHome picker="heading" />
        </State>
        <State label="Base branch">
          <HeldHome picker="branch" />
        </State>
      </Row>
      <Row name="Live">
        <LiveHome />
      </Row>
    </Section>
  );
}
