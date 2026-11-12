// Add project on Fake data [D165, D168, D202]: one live copy, its states picked by toggles.
import { useMemo, useState } from "react";

import { Button } from "../src/components/button";
import { CheckboxRow } from "../src/components/checkbox-row";
import { Dialog, DialogContent } from "../src/components/dialog";
import { Segmented } from "../src/components/segmented";
import { ADD_PROJECT_FRAME, AddProject } from "../src/projects/add-project";
import type { FolderCheck, GitHub, Repo, Source } from "../src/projects/store";
import { Held, Section } from "./parts";

const REPOS: Repo[] = [
  { path: "/Users/you/code/invoice-service", name: "invoice-service", project_id: null },
  { path: "/Users/you/Development/brigadier", name: "brigadier", project_id: null },
  { path: "/Users/you/code/hello", name: "hello", project_id: "p-hello" },
  { path: "/Users/you/code/design-tokens", name: "design-tokens", project_id: null },
  { path: "/Users/you/Projects/landing-page", name: "landing-page", project_id: null },
];
const GITHUB: GitHub = {
  repos: [
    { name: "you/invoice-service", description: "Billing and invoices for the shop", private: true },
    { name: "you/dotfiles", description: "My shell and editor setup", private: false },
    { name: "you/landing-page", description: null, private: false },
    { name: "acme/design-tokens", description: "Colours, type and spacing as tokens", private: true },
  ],
};

const never = <T,>() => new Promise<T>(() => {});
const after = <T,>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const fail = (ms: number, reason: string) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error(reason)), ms));

const LONG_NAME = "long-repo-".repeat(10);
const LONG_REPOS: Repo[] = [{ path: `/Users/you/code/${LONG_NAME}`, name: LONG_NAME, project_id: null }];
const LONG_GITHUB: GitHub = { repos: [{ name: `you/${LONG_NAME}`, description: "A repository with a long name", private: true }] };
const PICKED = "/Users/you/code/new-app";

type Mac = "found" | "none" | "loading" | "error";
type Gh = "signed-in" | "missing" | "signed-out";
type Picks = "repo" | "plain" | "missing" | "invalid";
type Toggles = { mac: Mac; gh: Gh; picks: Picks; long: boolean; gitFails: boolean; offline: boolean };

/** A Fake source answering like Rust would, a moment later, in the states the toggles pick. */
function fake(t: Toggles): Source {
  const mine = t.long ? LONG_REPOS : REPOS;
  const checks: Record<Picks, FolderCheck> = {
    repo: { kind: "repo", repo: PICKED, name: "new-app", project_id: null },
    plain: { kind: "plain", path: PICKED, name: "new-app" },
    missing: { kind: "missing", path: PICKED },
    invalid: { kind: "invalid", reason: "That's a file, not a folder." },
  };
  return {
    find: () => (t.mac === "loading" ? never() : t.mac === "error" ? fail(400, "Couldn't read ~/code: permission denied") : after(400, t.mac === "none" ? [] : mine)),
    check: () => after(100, checks[t.picks]),
    add: () => (t.gitFails ? fail(600, "Author identity unknown: please tell git who you are (git config --global user.email).") : after(600, "")),
    clone: () => (t.gitFails ? fail(1500, "Repository not found.") : after(1500, "")),
    github: () => after(300, t.gh === "signed-in" ? (t.long ? LONG_GITHUB : GITHUB) : { gh: t.gh }),
    pick: () => after(0, PICKED),
  };
}

const START: Toggles = { mac: "found", gh: "signed-in", picks: "repo", long: false, gitFails: false, offline: false };

/** Live: the dialog on a Fake source; each toggle starts it over in that state. */
function LiveAddProject() {
  const [t, setT] = useState(START);
  const [opening, setOpening] = useState(0);
  const set = (next: Partial<Toggles>) => {
    setT({ ...t, ...next });
    setOpening(opening + 1);
  };
  const source = useMemo(() => fake(t), [t]);
  return (
    <div className="flex flex-col gap-4">
      <Held className="h-152 w-196 overflow-hidden rounded-surface">
        {(box) => (
          <Dialog open modal={false}>
            <DialogContent container={box} initialFocus={false} frame={ADD_PROJECT_FRAME}>
              <AddProject key={opening} source={source} offline={t.offline} />
            </DialogContent>
          </Dialog>
        )}
      </Held>
      <div className="flex flex-col items-start gap-3">
        <Segmented<Mac>
          label="On this Mac"
          value={t.mac}
          onChange={(mac) => set({ mac })}
          options={[
            { value: "found", label: "Repositories found" },
            { value: "none", label: "None found" },
            { value: "loading", label: "Loading" },
            { value: "error", label: "Can't read" },
          ]}
        />
        <Segmented<Gh>
          label="GitHub"
          value={t.gh}
          onChange={(gh) => set({ gh })}
          options={[
            { value: "signed-in", label: "gh signed in" },
            { value: "missing", label: "gh not installed" },
            { value: "signed-out", label: "gh signed out" },
          ]}
        />
        <Segmented<Picks>
          label="Choose folder picks"
          value={t.picks}
          onChange={(picks) => set({ picks })}
          options={[
            { value: "repo", label: "Picks a repository" },
            { value: "plain", label: "A folder without git" },
            { value: "missing", label: "A folder that's gone" },
            { value: "invalid", label: "Not a folder" },
          ]}
        />
        <div className="flex flex-wrap gap-4">
          <CheckboxRow label="Long names" checked={t.long} onCheckedChange={(long) => set({ long })} />
          <CheckboxRow label="git fails (clone, new repository)" checked={t.gitFails} onCheckedChange={(gitFails) => set({ gitFails })} />
          <CheckboxRow label="Offline" checked={t.offline} onCheckedChange={(offline) => set({ offline })} />
          <Button size="sm" variant="outline" onClick={() => setOpening(opening + 1)}>
            Start over
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ProjectsGallery() {
  return (
    <Section title="Add project">
      <LiveAddProject />
    </Section>
  );
}
