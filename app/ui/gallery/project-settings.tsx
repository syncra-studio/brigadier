// Trust this folder?, the project menu, Project settings and Remove project live on Fake data, their states picked by
// toggles [D166, D167, D171, D178, D201, D202, D212].
import { type ReactNode, useMemo, useState } from "react";

import { Button } from "../src/components/button";
import { CheckboxRow } from "../src/components/checkbox-row";
import { Dialog, DialogContent } from "../src/components/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../src/components/menu";
import { Segmented } from "../src/components/segmented";
import { DotsHorizontal } from "../src/icons";
import { ProjectMenuItems } from "../src/projects/menu";
import type { Project } from "../src/projects/projects";
import { type Preview, RemoveFlow, type RemoveSource } from "../src/projects/remove";
import { ProjectSettings, type Refused, SETTINGS_FRAME, type SettingsSource } from "../src/projects/settings";
import { TrustForm } from "../src/projects/trust";
import { Held, Row, Section, State } from "./parts";

const PROJECT: Project = { id: "p-1", name: "invoice-service", folder: "/Users/you/code/invoice-service", trusted: true, setup: "pnpm install", include: [".env", "config/local.json"], added: 0 };
const LONG_FOLDER = "/Users/you/Development/clients/acme-corporation/platform/services/billing/invoice-service";

const never = <T,>() => new Promise<T>(() => {});
const after = <T,>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const fail = (ms: number, reason: string) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error(reason)), ms));

/** A dialog held open in its own box, as the app shows it. */
function Framed({ className, frame, close = false, children }: { className: string; frame: string; close?: boolean; children: ReactNode }) {
  return (
    <Held className={`${className} overflow-hidden rounded-surface`}>
      {(box) => (
        <Dialog open modal={false}>
          <DialogContent container={box} initialFocus={false} frame={frame} showCloseButton={close}>
            {children}
          </DialogContent>
        </Dialog>
      )}
    </Held>
  );
}

/** A frozen dialog with its label, for the other galleries' rows. */
export function Frozen({ label, frame, tall, children }: { label: string; frame: string; tall?: boolean; children: ReactNode }) {
  return (
    <State label={label}>
      <Framed className={tall ? "h-232 w-200" : "h-80 w-160"} frame={frame} close={!!tall}>
        {children}
      </Framed>
    </State>
  );
}

/** What the Fake would have Rust run, under a live dialog. */
const Ran = ({ line }: { line: string | null }) => <p className="font-mono text-xs text-muted-foreground">{line ?? "What it asks Rust to run shows here"}</p>;

const Toggles = ({ children }: { children: ReactNode }) => <div className="flex flex-col items-start gap-3">{children}</div>;

function LiveTrust() {
  const [long, setLong] = useState(false);
  const [refuses, setRefuses] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ran, setRan] = useState<string | null>(null);
  const [opening, setOpening] = useState(0);
  const again = () => {
    setError(null);
    setOpening(opening + 1);
  };
  const answer = (trusted: boolean) => {
    setRan(`projects set p-1 --trusted ${trusted}`);
    if (refuses) void fail(300, "Brigadier isn't running").catch((cause: Error) => setError(cause.message));
  };
  return (
    <div className="flex flex-col gap-3">
      <Framed className="h-80 w-160" frame="max-w-trust gap-0 p-0">
        <TrustForm key={opening} project={{ ...PROJECT, trusted: null, folder: long ? LONG_FOLDER : PROJECT.folder }} error={error} onAnswer={answer} />
      </Framed>
      <Ran line={ran} />
      <Toggles>
        <div className="flex flex-wrap gap-4">
          <CheckboxRow label="Long path" checked={long} onCheckedChange={setLong} />
          <CheckboxRow label="Rust refuses the answer" checked={refuses} onCheckedChange={setRefuses} />
          <Button size="sm" variant="outline" onClick={again}>
            Start over
          </Button>
        </div>
      </Toggles>
    </div>
  );
}

function LiveMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Project actions" />}>
        <DotsHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <ProjectMenuItems project={PROJECT} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LiveSettings() {
  const [project, setProject] = useState(PROJECT);
  const [refuses, setRefuses] = useState(false);
  const [refused, setRefused] = useState<Refused | undefined>();
  const [ran, setRan] = useState<string | null>(null);
  const [opening, setOpening] = useState(0);
  const reopen = (next?: Refused) => {
    setRefused(next);
    setOpening((n) => n + 1);
  };
  const source: SettingsSource = useMemo(
    () => ({
      pick: () => after(0, "/Users/you/code/invoice-service-v2"),
      check: (path) => after(100, { kind: "repo", repo: path, name: path.split("/").at(-1)!, project_id: null }),
      save: (_, change, args) => {
        setRan(`projects set p-1 ${args.map((arg) => JSON.stringify(arg)).join(" ")}`);
        if (refuses) return fail(400, "That prefix doesn't make a valid git branch name.");
        setProject((last) => ({ ...last, ...change }));
        return after(400, undefined);
      },
    }),
    [refuses],
  );
  const set = (change: Partial<Project>) => {
    setProject({ ...project, ...change });
    reopen();
  };
  return (
    <div className="flex flex-col gap-3">
      <Framed className="h-232 w-200" frame={SETTINGS_FRAME} close>
        <ProjectSettings key={opening} project={project} source={source} refused={refused} onClose={() => reopen()} onRefused={reopen} />
      </Framed>
      <Ran line={ran} />
      <Toggles>
        <div className="flex flex-wrap gap-4">
          <CheckboxRow label="Long path" checked={project.folder === LONG_FOLDER} onCheckedChange={(on) => set({ folder: on ? LONG_FOLDER : PROJECT.folder })} />
          <CheckboxRow label="Trust unanswered" checked={project.trusted === null} onCheckedChange={(on) => set({ trusted: on ? null : true })} />
          <CheckboxRow label="Rust refuses the save" checked={refuses} onCheckedChange={setRefuses} />
          <Button size="sm" variant="outline" onClick={() => reopen()}>
            Start over
          </Button>
        </div>
      </Toggles>
    </div>
  );
}

const PREVIEW: Preview = { sessions: ["s-1", "s-2", "s-3"], working: [], worktrees: 2, bytes: 48_300_000, merged: 1, branches: [] };
type Has = "goes" | "nothing" | "branch" | "branches" | "lost" | "working" | "looking" | "failed";
const HAS: Record<Exclude<Has, "looking" | "failed">, Preview> = {
  goes: PREVIEW,
  nothing: { ...PREVIEW, sessions: [], worktrees: 0, merged: 0 },
  branch: { ...PREVIEW, branches: [{ id: "s-2", branch: "brigadier/s-2" }] },
  branches: { ...PREVIEW, branches: [{ id: "s-2", branch: "brigadier/s-2" }, { id: "s-3", branch: "brigadier/s-3" }] },
  lost: { ...PREVIEW, lost: [{ ids: ["s-1"], files: [".env", "notes/todo.md"] }] },
  working: { ...PREVIEW, working: ["s-1"] },
};

function LiveRemove() {
  const [has, setHas] = useState<Has>("goes");
  const [partly, setPartly] = useState(false);
  const [ran, setRan] = useState<string | null>(null);
  const [opening, setOpening] = useState(0);
  const source: RemoveSource = useMemo(() => {
    const preview = has === "looking" || has === "failed" ? null : HAS[has];
    return {
      check: () => (has === "looking" ? never() : has === "failed" ? fail(400, "Brigadier isn't running") : after(400, preview!)),
      remove: (id, drop, reply) => {
        setRan(`projects remove ${id}${drop.length ? ` --drop ${drop.join(",")}` : ""}`);
        const kept = (preview?.branches ?? []).filter((each) => !drop.includes(each.id)).map((each) => each.branch);
        void after(800, null).then(() =>
          reply(partly ? { ok: false, left: ["worktree: git worktree remove: permission denied"] } : { ok: true, repo: PROJECT.folder, kept_branches: kept }),
        );
      },
    };
  }, [has, partly]);
  const set = (next: () => void) => {
    next();
    setOpening(opening + 1);
  };
  return (
    <div className="flex flex-col gap-3">
      <Framed className="h-232 w-200" frame="project-dialog max-w-project-dialog gap-5 p-6">
        <RemoveFlow key={opening} project={PROJECT} source={source} onClose={() => setOpening(opening + 1)} />
      </Framed>
      <Ran line={ran} />
      <Toggles>
        <Segmented<Has>
          label="What the project has"
          className="flex-wrap"
          value={has}
          onChange={(next) => set(() => setHas(next))}
          options={[
            { value: "goes", label: "Sessions and worktrees" },
            { value: "nothing", label: "Nothing made" },
            { value: "branch", label: "A branch to ask about" },
            { value: "branches", label: "Branches to ask about" },
            { value: "lost", label: "Ignored files lost" },
            { value: "working", label: "One working" },
            { value: "looking", label: "Still looking" },
            { value: "failed", label: "Can't look" },
          ]}
        />
        <div className="flex flex-wrap gap-4">
          <CheckboxRow label="Remove partly fails" checked={partly} onCheckedChange={(on) => set(() => setPartly(on))} />
          <Button size="sm" variant="outline" onClick={() => setOpening(opening + 1)}>
            Start over
          </Button>
        </div>
      </Toggles>
    </div>
  );
}

export function ProjectSettingsGallery() {
  return (
    <Section title="Project trust and settings">
      <Row name="Trust this folder?">
        <LiveTrust />
      </Row>
      <Row name="Project menu (the sidebar's project row ⋯)">
        <LiveMenu />
      </Row>
      <Row name="Project settings">
        <LiveSettings />
      </Row>
      <Row name="Remove project">
        <LiveRemove />
      </Row>
    </Section>
  );
}
