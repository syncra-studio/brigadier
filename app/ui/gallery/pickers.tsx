// The pickers, one live copy each: the model and the permission; project, Work in and branch are in the composer's Home rail.
import { useState } from "react";

import { type ModelChoice, type ModelGroup, ModelPicker } from "../src/components/composer/model-picker";
import { type PermissionLevel, PermissionPicker } from "../src/components/composer/pickers";
import { RailItem } from "../src/components/composer/rail";
import { BranchPicker, type RepoState } from "../src/home/branch";
import { type DraftProject, ProjectPicker, UtilityBar, type WorkIn, WorkInPicker } from "../src/home/pills";
import { showToast } from "../src/components/toast";
import { Section } from "./parts";

// Stand-in marks: no agent's real logo in gallery code (onboarding takes them from the adapters).
const RING = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="5.5"/></svg>';
const DIAMOND = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5 14.5 8 8 14.5 1.5 8Z"/></svg>';

export const GROUPS: ModelGroup[] = [
  {
    provider: "cloud",
    label: "Cloud agent",
    mark: RING,
    models: [
      { id: "large", name: "Large model", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
      { id: "fast", name: "Fast model", efforts: ["low", "medium", "high"], defaultEffort: "low" },
      { id: "mini", name: "Mini model with a long name that truncates", efforts: [] },
    ],
  },
  { provider: "other", label: "Other agent", mark: DIAMOND, models: [{ id: "big", name: "Big model", efforts: ["low", "high", "max"], defaultEffort: "high" }] },
  { provider: "local", label: "Local models", mark: null, models: [{ id: "llama", name: "Local 8B", efforts: [] }] },
  { provider: "new", label: "New agent", mark: null, models: [] },
  { provider: "absent", label: "Absent agent", mark: DIAMOND, models: [], unavailable: "install" },
  { provider: "away", label: "Signed-out agent", mark: RING, models: [], unavailable: "sign-in" },
];

const PROJECTS: DraftProject[] = [
  { id: "p-todo", name: "todo-app" },
  { id: "p-invoice", name: "invoice-service" },
  { id: "p-tokens", name: "design-tokens" },
];
const INFO: RepoState["info"] = {
  current: "main",
  branches: ["main", "feat/invoices", "fix/rounding"],
  worktrees: [{ path: "/Users/you/code/todo-review", branch: "review" }],
};

/** Home's rail: project, Work in and branch, live; loading and failed are what only Rust's answer about the repository changes. */
export function ProjectBar({ loading, failed }: { loading: boolean; failed: boolean }) {
  const [project, setProject] = useState<DraftProject | null>(PROJECTS[0]!);
  const [workIn, setWorkIn] = useState<WorkIn>("worktree");
  const [base, setBase] = useState<string | null>(null);
  const [worktree, setWorktree] = useState<string | null>(null);
  const repo: RepoState = { info: loading || failed ? undefined : INFO, error: failed ? "Couldn't read the branches: not a git repository" : undefined, loading, refresh: () => {} };
  return (
    <RailItem variant="controls" label="Composer utility bar">
      <UtilityBar>
        <ProjectPicker
          projects={PROJECTS}
          value={project}
          onChange={(id) => setProject(PROJECTS.find((each) => each.id === id)!)}
          onAdd={(path) => showToast(path ? `Add project at ${path}` : "Add project")}
          onNone={() => setProject(null)}
        />
        {project && (
          <>
            <WorkInPicker value={workIn} onChange={setWorkIn} repo={project.name} />
            <BranchPicker workIn={workIn} repo={repo} name={project.name} base={base} worktree={worktree} onBase={setBase} onWorktree={setWorktree} />
          </>
        )}
      </UtilityBar>
    </RailItem>
  );
}

export function PickersGallery() {
  const [model, setModel] = useState<ModelChoice>({ provider: "cloud", model: "large", effort: "high" });
  const [permission, setPermission] = useState<PermissionLevel>("ask");
  return (
    <>
      <Section title="Model picker">
        <div className="self-start">
          <ModelPicker groups={GROUPS} value={model} onChange={setModel} />
        </div>
      </Section>
      <Section title="Permission picker">
        <div className="self-start">
          <PermissionPicker value={permission} onChange={setPermission} />
        </div>
      </Section>
    </>
  );
}
