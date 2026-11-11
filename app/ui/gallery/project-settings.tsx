// Trust this folder?, Project settings and the project menu on Fake data [D166, D167, D171, D178, D201, D202, D212].
import type { ReactNode } from "react";
import { Button } from "../src/components/button";
import { Dialog, DialogContent } from "../src/components/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../src/components/menu";
import { DotsHorizontal } from "../src/icons";
import { ProjectMenuItems } from "../src/projects/menu";
import type { Project } from "../src/projects/projects";
import { type Preview, RemoveFlow, Removed } from "../src/projects/remove";
import { ProjectSettings, type Refused, SETTINGS_FRAME, type SettingsSource } from "../src/projects/settings";
import { TrustForm } from "../src/projects/trust";
import { Held, Row, Section, State } from "./parts";

const PROJECT: Project = { id: "p-1", name: "invoice-service", folder: "/Users/you/code/invoice-service", trusted: null, setup: "", include: [], added: 0 };
const LONG: Project = { ...PROJECT, folder: "/Users/you/Development/clients/acme-corporation/platform/services/billing/invoice-service" };
const SET: Project = { ...PROJECT, trusted: true, include: [".env", "config/local.json"], setup: "pnpm install" };

const after = <T,>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

function fake(with_: Partial<SettingsSource> = {}): SettingsSource {
  return {
    pick: () => after(0, "/Users/you/code/invoice-service-v2"),
    check: (path) => after(100, { kind: "repo", repo: path, name: path.split("/").at(-1)!, project_id: null }),
    save: () => after(400, undefined),
    ...with_,
  };
}
const FAKE = fake();

const PREVIEW: Preview = { sessions: ["s-1", "s-2", "s-3"], working: [], worktrees: 2, bytes: 48_300_000, merged: 1, branches: [] };
const BRANCHES: Preview = { ...PREVIEW, branches: [{ id: "s-2", branch: "brigadier/s-2" }, { id: "s-3", branch: "brigadier/s-3" }] };
const REMOVE = "project-dialog max-w-project-dialog gap-5 p-6";
const ready = (preview: Preview) => ({ state: "ready" as const, preview });

/** A dialog held open in its own box, as the app shows it. */
export function Frozen({ label, frame, tall, children }: { label: string; frame: string; tall?: boolean; children: ReactNode }) {
  return (
    <State label={label}>
      <Held className={`${tall ? "h-232 w-200" : "h-80 w-160"} overflow-hidden rounded-surface`}>
        {(box) => (
          <Dialog open modal={false}>
            <DialogContent container={box} initialFocus={false} frame={frame} showCloseButton={!!tall}>
              {children}
            </DialogContent>
          </Dialog>
        )}
      </Held>
    </State>
  );
}

const Settings = ({ label, project = SET, source = FAKE, refused }: { label: string; project?: Project; source?: SettingsSource; refused?: Refused }) => (
  <Frozen label={label} frame={SETTINGS_FRAME} tall>
    <ProjectSettings project={project} source={source} refused={refused} onClose={() => {}} />
  </Frozen>
);

export function ProjectSettingsGallery() {
  return (
    <Section title="Project trust and settings">
      <Row name="Trust this folder? · short path · long path cut in the middle · refused">
        <Frozen label="short path" frame="max-w-trust gap-0 p-0">
          <TrustForm project={PROJECT} error={null} onAnswer={() => {}} />
        </Frozen>
        <Frozen label="long path" frame="max-w-trust gap-0 p-0">
          <TrustForm project={LONG} error={null} onAnswer={() => {}} />
        </Frozen>
        <Frozen label="refused" frame="max-w-trust gap-0 p-0">
          <TrustForm project={PROJECT} error="Brigadier isn't running" onAnswer={() => {}} />
        </Frozen>
      </Row>
      <Row name="project menu (on the sidebar's project row)">
        <State label="open">
          <Held className="h-52 w-64">
            {(box) => (
              <DropdownMenu open modal={false}>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Project actions" />}>
                  <DotsHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent container={box} align="start" collisionAvoidance={{ side: "none", align: "none" }}>
                  <ProjectMenuItems project={SET} />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </Held>
        </State>
      </Row>
      <Row name="Remove project: looking · nothing made · what goes · branches to ask about · ignored files lost · one working · partly failed · lost the connection · removed, branches kept">
        <Frozen label="looking" frame={REMOVE}>
          <RemoveFlow project={SET} onClose={() => {}} given={{ look: { state: "looking" } }} />
        </Frozen>
        <Frozen label="nothing made" frame={REMOVE}>
          <RemoveFlow project={SET} onClose={() => {}} given={{ look: ready({ ...PREVIEW, sessions: [], worktrees: 0, merged: 0 }) }} />
        </Frozen>
        <Frozen label="what goes" frame={REMOVE}>
          <RemoveFlow project={SET} onClose={() => {}} given={{ look: ready(PREVIEW) }} />
        </Frozen>
        <Frozen label="branches to ask about" frame={REMOVE} tall>
          <RemoveFlow project={SET} onClose={() => {}} given={{ look: ready(BRANCHES) }} />
        </Frozen>
        <Frozen label="ignored files lost" frame={REMOVE} tall>
          <RemoveFlow project={SET} onClose={() => {}} given={{ look: ready({ ...PREVIEW, lost: [{ ids: ["s-1"], files: [".env", "notes/todo.md"] }] }) }} />
        </Frozen>
        <Frozen label="one working" frame={REMOVE}>
          <RemoveFlow project={SET} onClose={() => {}} given={{ look: ready({ ...PREVIEW, working: ["s-1"] }) }} />
        </Frozen>
        <Frozen label="partly failed" frame={REMOVE}>
          <RemoveFlow
            project={SET}
            onClose={() => {}}
            given={{ look: ready(PREVIEW), error: "Not everything went, so “invoice-service” stays: worktree: git worktree remove: permission denied" }}
          />
        </Frozen>
        <Frozen label="lost the connection" frame={REMOVE}>
          <RemoveFlow project={SET} onClose={() => {}} given={{ look: ready(PREVIEW), phase: { at: "watching" } }} />
        </Frozen>
        <Frozen label="removed, branches kept" frame={REMOVE}>
          <Removed name={SET.name} repo={SET.folder} kept={["brigadier/s-2"]} onClose={() => {}} />
        </Frozen>
      </Row>
      <Row name="Project settings: unanswered with a long path · a refused prefix, opened again on what was typed">
        <Settings label="default prefix" project={LONG} />
        <Settings label="custom prefix" project={{ ...SET, branch_prefix: "feature/" }} />
        <Settings label="no prefix" project={{ ...SET, branch_prefix: "" }} />
        <Settings label="refused prefix" refused={{ change: { branch_prefix: "bad..x/" }, error: "That prefix doesn't make a valid git branch name." }} />
      </Row>
    </Section>
  );
}
