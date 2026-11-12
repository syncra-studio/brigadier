// Home's new-session draft on Fake data [D160, D161]: one live copy, its composer and pickers working.
import { useState } from "react";

import type { ModelChoice, ModelGroup } from "../src/components/composer/model-picker";
import type { RepoState } from "../src/home/branch";
import type { DraftProject, WorkIn } from "../src/home/pills";
import { type HomeProps, HomeView } from "../src/home/view";
import { LevelPill } from "./composer";
import { Section } from "./parts";

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

/** The live copy: picks change it, Send shows what would start. */
function LiveHome() {
  const [project, setProject] = useState<DraftProject>(PROJECTS[0]!);
  const [workIn, setWorkIn] = useState<WorkIn>("worktree");
  const [model, setModel] = useState(LARGE);
  const [base, setBase] = useState<string | null>(null);
  const [worktree, setWorktree] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-150 w-200 flex-col rounded-surface bg-background ring ring-border">
        <HomeView
          {...BASE}
          project={project}
          onProject={(id) => setProject(PROJECTS.find((each) => each.id === id)!)}
          workIn={workIn}
          onWorkIn={setWorkIn}
          base={base}
          onBase={setBase}
          worktree={worktree}
          onWorktree={setWorktree}
          model={model}
          onModel={setModel}
          onSend={(text) => setSent(`start --project ${project.id}${workIn === "local" ? " --local" : ""} --backend ${model.provider} --model ${model.model} --text ${JSON.stringify(text)}`)}
        />
      </div>
      <p className="font-mono text-xs text-muted-foreground">{sent ?? "Send shows the start command here"}</p>
    </div>
  );
}

export function HomeGallery() {
  return (
    <Section title="Home: new-session draft">
      <LiveHome />
    </Section>
  );
}
