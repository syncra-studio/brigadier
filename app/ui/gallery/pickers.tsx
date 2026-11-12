// Every picker, one live copy each: project, Work in and branch as Home has them, the model, the permission and the
// panel's branch quick pick. The agents are Rust's, with their marks from their adapters.
import { useEffect, useRef, useState } from "react";

import { Button } from "../src/components/button";
import { CheckboxRow } from "../src/components/checkbox-row";
import { type ModelChoice, type ModelGroup, ModelPicker } from "../src/components/composer/model-picker";
import { type PermissionLevel, PermissionPicker } from "../src/components/composer/pickers";
import { BranchPicker, type RepoState } from "../src/home/branch";
import { type DraftProject, ProjectPicker, UtilityBar, type WorkIn, WorkInPicker } from "../src/home/pills";
import { showToast } from "../src/components/toast";
import { useBranchPicker } from "../src/panel/branch-picker";
import { BRANCHES, CLEAN, HOST } from "../src/panel/fake";
import { asGroups } from "../src/session/model";
import { Section } from "./parts";

// Stand-in marks for the states this Mac's agents may not be in: no agent's real logo in gallery code.
const RING = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="5.5"/></svg>';
const DIAMOND = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5 14.5 8 8 14.5 1.5 8Z"/></svg>';
const UNAVAILABLE: ModelGroup[] = [
  { provider: "absent", label: "Absent agent", mark: DIAMOND, models: [], unavailable: "install" },
  { provider: "away", label: "Signed-out agent", mark: RING, models: [], unavailable: "sign-in" },
];
// Until Rust answers, or where it can't.
const STAND_IN: ModelGroup[] = [{ provider: "cloud", label: "Cloud agent", mark: RING, models: [{ id: "large", name: "Large model", efforts: ["low", "medium", "high"], defaultEffort: "medium" }] }, ...UNAVAILABLE];

let agents: Promise<ModelGroup[]> | undefined;
/** This Mac's agents and models as Rust lists them for Home, then a stand-in for each unavailable state none is in; read once a load. */
export function useAgents(): ModelGroup[] {
  const [groups, setGroups] = useState(STAND_IN);
  useEffect(() => {
    agents ??= window.top!.galleryRun!(["models", "--fresh"]).then((reply) => {
      const groups = asGroups(reply.groups);
      return [...groups, ...UNAVAILABLE.filter((stand) => !groups.some((group) => group.unavailable === stand.unavailable))];
    });
    agents.then(setGroups, (cause) => showToast(`Couldn't read the agents: ${cause.message}`, { tone: "error" }));
  }, []);
  return groups;
}

/** The model picker on Rust's list: the first model there until one is picked. */
export function LiveModelPicker() {
  const groups = useAgents();
  const [picked, setPicked] = useState<ModelChoice | null>(null);
  const listed = groups.some((group) => group.provider === picked?.provider && group.models.some((model) => model.id === picked.model));
  const first = groups.find((group) => !group.unavailable && group.models.length > 0)!;
  const value = listed ? picked! : { provider: first.provider, model: first.models[0]!.id, effort: first.models[0]!.defaultEffort ?? null };
  return <ModelPicker groups={groups} value={value} onChange={setPicked} />;
}

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

/** Home's project, Work in and branch pickers; loading and failed are what only Rust's answer about the repository changes. */
export function ProjectBar({ loading, failed }: { loading: boolean; failed: boolean }) {
  const [project, setProject] = useState<DraftProject | null>(PROJECTS[0]!);
  const [workIn, setWorkIn] = useState<WorkIn>("worktree");
  const [base, setBase] = useState<string | null>(null);
  const [worktree, setWorktree] = useState<string | null>(null);
  const repo: RepoState = { info: loading || failed ? undefined : INFO, error: failed ? "Couldn't read the branches: not a git repository" : undefined, loading, refresh: () => {} };
  return (
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
  );
}

/** The repository's states for the project bar, toggled: what only Rust's answer changes. */
export function BranchToggles({ loading, failed, onLoading, onFailed }: { loading: boolean; failed: boolean; onLoading: (on: boolean) => void; onFailed: (on: boolean) => void }) {
  return (
    <>
      <CheckboxRow label="Branches loading" checked={loading} onCheckedChange={onLoading} />
      <CheckboxRow label="Branches can't be read" checked={failed} onCheckedChange={onFailed} />
    </>
  );
}

/** The panel's branch quick pick under the card's branch row: in the user's own folder it switches, in a session it offers its actions. A pick only closes here. */
function PanelBranch({ folder }: { folder: boolean }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [working, setWorking] = useState(false);
  const source = folder ? { ...CLEAN, checkout: "folder" as const, branch: "main" } : CLEAN;
  const { open, pickers } = useBranchPicker({ data: { source, step: null, branches: BRANCHES, host: HOST, agentWorking: working }, base: "main", nowMs: Date.now(), anchor });
  return (
    <div className="flex flex-col items-start gap-3">
      <div ref={anchor}>
        <Button size="sm" variant="outline" onClick={() => open("branch")}>
          {source.branch}
        </Button>
      </div>
      {pickers}
      {folder && <CheckboxRow label="The agent is working" checked={working} onCheckedChange={setWorking} />}
    </div>
  );
}

export function PickersGallery() {
  const [permission, setPermission] = useState<PermissionLevel>("ask");
  const [untrusted, setUntrusted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <Section title="Project, Work in and branch">
        <div className="flex flex-col items-start gap-4">
          <ProjectBar loading={loading} failed={failed} />
          <div className="flex flex-wrap gap-4">
            <BranchToggles loading={loading} failed={failed} onLoading={setLoading} onFailed={setFailed} />
          </div>
        </div>
      </Section>
      <Section title="Model picker">
        <div className="self-start">
          <LiveModelPicker />
        </div>
      </Section>
      <Section title="Permission picker">
        <div className="flex flex-col items-start gap-4">
          <PermissionPicker value={untrusted ? "ask" : permission} untrusted={untrusted} onChange={setPermission} />
          <CheckboxRow label="Folder not trusted" checked={untrusted} onCheckedChange={setUntrusted} />
        </div>
      </Section>
      <Section title="Branch quick pick">
        <div className="flex flex-wrap gap-8">
          <PanelBranch folder />
          <PanelBranch folder={false} />
        </div>
      </Section>
    </>
  );
}
